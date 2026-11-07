import { record, type PulledIssue } from './columns.js';
import { jiraError, jiraOk, type JiraResult } from './errors.js';
import type { JiraClient } from './http.js';

/** What one `jira.pull` step names to pull: exactly one of the four. */
export type Selector =
  | { readonly kind: 'jql'; readonly jql: string }
  | { readonly kind: 'board'; readonly board: number }
  | { readonly kind: 'keys'; readonly keys: readonly string[] }
  | { readonly kind: 'parent'; readonly key: string };

/** Issues per search page: Jira's default, and small enough to fit a call's deadline. */
export const PAGE_SIZE = 50;
const COMMENT_PAGE_SIZE = 100;
const SEARCH_PATH = '/rest/api/3/search/jql';

/**
 * The JQL a selector means. A board is read through its configuration's saved filter, on
 * every page, so a filter edited mid-pull changes the fingerprint and is refused. A Kanban
 * board's `subQuery` (the rule that hides old done issues from the board) is not applied: the
 * filter is what the board is, and the sub-query is how the board draws it.
 */
export async function jqlOf(client: JiraClient, selector: Selector): Promise<JiraResult<string>> {
  switch (selector.kind) {
    case 'jql':
      return jiraOk(selector.jql);
    case 'keys':
      return jiraOk(`key in (${selector.keys.join(', ')})`);
    case 'parent':
      return jiraOk(`parent = ${selector.key}`);
    case 'board':
      return boardJql(client, selector.board);
  }
}

async function boardJql(client: JiraClient, board: number): Promise<JiraResult<string>> {
  const configuration = await client.get(`/rest/agile/1.0/board/${board}/configuration`);
  if (!configuration.ok) return configuration;
  const filterId = record(record(configuration.value)?.['filter'])?.['id'];
  if (typeof filterId !== 'string' && typeof filterId !== 'number') {
    return jiraError(
      'E_JIRA_CONFIG',
      `board ${board} has no saved filter, so there is no JQL to pull it by. Pull its project ` +
        'with jql= instead.',
    );
  }
  const filter = await client.get(`/rest/api/3/filter/${encodeURIComponent(String(filterId))}`);
  if (!filter.ok) return filter;
  const jql = record(filter.value)?.['jql'];
  if (typeof jql !== 'string' || jql.trim() === '') {
    return jiraError(
      'E_JIRA_RESPONSE',
      `filter ${String(filterId)} of board ${board} answered no JQL.`,
    );
  }
  return jiraOk(jql);
}

export interface SearchPage {
  readonly issues: readonly PulledIssue[];
  readonly nextPageToken?: string;
  readonly isLast: boolean;
}

/** One page of `POST /rest/api/3/search/jql`, its shape checked. */
export async function searchPage(
  client: JiraClient,
  jql: string,
  fields: readonly string[],
  token: string | undefined,
): Promise<JiraResult<SearchPage>> {
  const answer = await client.post(SEARCH_PATH, {
    jql,
    fields,
    maxResults: PAGE_SIZE,
    ...(token === undefined ? {} : { nextPageToken: token }),
  });
  if (!answer.ok) return answer;
  const body = record(answer.value);
  const issues = body?.['issues'];
  if (body === undefined || !Array.isArray(issues)) {
    return shapeError(`POST ${SEARCH_PATH} answered no issues list`);
  }
  const pulled: PulledIssue[] = [];
  for (const issue of issues) {
    const checked = issueOf(issue);
    if (checked === undefined) {
      return shapeError(`POST ${SEARCH_PATH} answered an issue without an id, a key or fields`);
    }
    pulled.push(checked);
  }
  const next = body['nextPageToken'];
  if (next !== undefined && next !== null && (typeof next !== 'string' || next === '')) {
    return shapeError(`POST ${SEARCH_PATH} answered a nextPageToken that is not text`);
  }
  const nextPageToken = typeof next === 'string' ? next : undefined;
  const isLast = body['isLast'];
  if (isLast !== undefined && typeof isLast !== 'boolean') {
    return shapeError(`POST ${SEARCH_PATH} answered an isLast that is not true or false`);
  }
  return jiraOk({
    issues: pulled,
    ...(nextPageToken === undefined ? {} : { nextPageToken }),
    isLast: isLast ?? nextPageToken === undefined,
  });
}

/**
 * Every comment's body, in the order they were made. The search embeds only the first ones;
 * when its `total` says there are more, the issue's comments are read whole, page by page.
 */
export async function commentBodies(
  client: JiraClient,
  issue: PulledIssue,
): Promise<JiraResult<readonly unknown[]>> {
  const embedded = record(issue.fields['comment']);
  const comments = Array.isArray(embedded?.['comments']) ? embedded['comments'] : [];
  const total = embedded?.['total'];
  if (typeof total !== 'number' || total <= comments.length) {
    return jiraOk(comments.map((comment) => record(comment)?.['body']));
  }
  const path = `/rest/api/3/issue/${encodeURIComponent(issue.key)}/comment`;
  const bodies: unknown[] = [];
  while (bodies.length < total) {
    const page = await client.get(path, {
      orderBy: 'created',
      startAt: bodies.length,
      maxResults: COMMENT_PAGE_SIZE,
    });
    if (!page.ok) return page;
    const answered = record(page.value)?.['comments'];
    if (!Array.isArray(answered)) return shapeError(`GET ${path} answered no comments list`);
    // An empty page before the total means comments were deleted while reading: stop there.
    if (answered.length === 0) break;
    bodies.push(...answered.map((comment) => record(comment)?.['body']));
  }
  return jiraOk(bodies);
}

/**
 * The description of every parent the page names, by parent key. A parent on the page is read
 * from it; the others in one `bulkfetch`. A parent Jira will not show (deleted, or another
 * project the account cannot see) comes back in `issueErrors` and is simply absent here.
 */
export async function parentDescriptions(
  client: JiraClient,
  issues: readonly PulledIssue[],
): Promise<JiraResult<ReadonlyMap<string, unknown>>> {
  const onPage = new Map(issues.map((issue) => [issue.key, issue.fields['description']]));
  const descriptions = new Map<string, unknown>();
  const missing = new Set<string>();
  for (const issue of issues) {
    const parent = record(issue.fields['parent'])?.['key'];
    if (typeof parent !== 'string') continue;
    if (onPage.has(parent)) descriptions.set(parent, onPage.get(parent));
    else missing.add(parent);
  }
  if (missing.size === 0) return jiraOk(descriptions);
  const fetched = await bulkIssues(client, [...missing], ['description']);
  if (!fetched.ok) return fetched;
  for (const issue of fetched.value.issues)
    descriptions.set(issue.key, issue.fields['description']);
  return jiraOk(descriptions);
}

/** Keys or ids per `bulkfetch`: the most Jira takes in one request. */
export const BULK_FETCH_SIZE = 100;
const BULK_FETCH_PATH = '/rest/api/3/issue/bulkfetch';

export interface BulkIssues {
  readonly issues: readonly PulledIssue[];
  /** What was asked for and named in `issueErrors`: deleted, or hidden from the account. */
  readonly refused: ReadonlySet<string>;
}

/**
 * The issues asked for, through `POST /rest/api/3/issue/bulkfetch`, {@link BULK_FETCH_SIZE} per
 * request. An issue Jira will not show comes back in `issueErrors`, not as a failure.
 */
export async function bulkIssues(
  client: JiraClient,
  idsOrKeys: readonly string[],
  fields: readonly string[],
): Promise<JiraResult<BulkIssues>> {
  const issues: PulledIssue[] = [];
  const refused = new Set<string>();
  for (let start = 0; start < idsOrKeys.length; start += BULK_FETCH_SIZE) {
    const answer = await client.post(BULK_FETCH_PATH, {
      issueIdsOrKeys: idsOrKeys.slice(start, start + BULK_FETCH_SIZE),
      fields,
    });
    if (!answer.ok) return answer;
    const body = record(answer.value);
    const fetched = body?.['issues'];
    if (!Array.isArray(fetched))
      return shapeError(`POST ${BULK_FETCH_PATH} answered no issues list`);
    for (const issue of fetched) {
      const checked = issueOf(issue);
      if (checked !== undefined) issues.push(checked);
    }
    const errors = body?.['issueErrors'];
    for (const error of Array.isArray(errors) ? errors : []) {
      const named = record(error)?.['issueIdsOrKeys'];
      for (const key of Array.isArray(named) ? named : []) {
        if (typeof key === 'string') refused.add(key);
      }
    }
  }
  return jiraOk({ issues, refused });
}

export function issueOf(value: unknown): PulledIssue | undefined {
  const issue = record(value);
  const fields = record(issue?.['fields']);
  const id = issue?.['id'];
  const key = issue?.['key'];
  if (typeof id !== 'string' || id === '' || typeof key !== 'string' || key === '') {
    return undefined;
  }
  return fields === undefined ? undefined : { id, key, fields };
}

function shapeError<T>(message: string): JiraResult<T> {
  return jiraError('E_JIRA_RESPONSE', `${message}.`);
}
