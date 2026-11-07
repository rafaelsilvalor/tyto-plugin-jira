import type { PluginHost, RecipeVerbContribution } from '@tyto/plugin-api';

import { FIXED_COLUMNS, FIXED_FIELDS, type PulledIssue } from './columns.js';
import { resolveJiraConfig } from './config.js';
import {
  REFRESH_VERB_ID,
  argumentsProblem,
  verbFailed,
  type ArgumentSpec,
  type CellValue,
  type Column,
  type Diagnostic,
  type Row,
} from './diagnostics.js';
import { jiraError, jiraOk, type JiraError, type JiraResult } from './errors.js';
import { mappedColumns, mappedFields, mappedTypes } from './fields.js';
import { createJiraClient, type JiraClient } from './http.js';
import { ISSUE_KEY } from './pull.js';
import { issueRow, readIssues } from './rows.js';
import { bulkIssues, issueOf, searchPage } from './search.js';

/** Issues one call refreshes at most: ten `bulkfetch` requests. */
export const MAX_KEYS = 1_000;
/** Children `children=true` adds at most: a hundred search pages. */
export const MAX_CHILDREN = 5_000;
/** How long one call may spend, under the host's 30 s deadline with room to answer. */
export const BUDGET_MILLISECONDS = 25_000;
/** Parent keys per `parent in (...)` search, so the JQL stays short. */
const PARENTS_PER_SEARCH = 100;

const ARGUMENTS: readonly ArgumentSpec[] = [
  { name: 'by', type: 'text' },
  { name: 'only', type: 'text' },
  { name: 'children', type: 'boolean' },
];

type TransformFunction = NonNullable<RecipeVerbContribution['transform']>;
type TransformRequest = Parameters<TransformFunction>[0];
type TransformAnswer = Awaited<ReturnType<TransformFunction>>;

/** The parts of the host a refresh uses: no cache, since a refresh is always live. */
export type RefreshHost = Pick<PluginHost, 'config' | 'credentials' | 'fetch'>;

/** The time a refresh measures its budget by; a test passes one it moves. */
export interface RefreshClock {
  now(): number;
  sleep?(milliseconds: number): Promise<void>;
}

const systemClock: RefreshClock = { now: () => Date.now() };

/**
 * `jira.refresh [by=<column>] [only=<boolean column>] [children=true]`: the table it is handed,
 * with every row that names an issue filled with what Jira holds now, in the columns
 * `jira.pull` answers. It is how a row `recall` brought back gets its current values
 * (Tyto ADR 0144), and with `children=true`, how `rollup` sees every child of a parent.
 */
export function refreshVerb(
  host: RefreshHost,
  clock: RefreshClock = systemClock,
): RecipeVerbContribution {
  return {
    id: REFRESH_VERB_ID,
    kind: 'transform',
    arguments: ARGUMENTS,
    transform: (request) => refreshTable(host, request, clock),
  };
}

export async function refreshTable(
  host: RefreshHost,
  request: TransformRequest,
  clock: RefreshClock = systemClock,
): Promise<TransformAnswer> {
  const { table } = request;
  const asked = readArguments(request);
  if ('severity' in asked) return refused(asked);
  const { by, only, children } = asked;
  const mapped = mappedFields(request.section);
  if (!mapped.ok) return refused(verbFailed(mapped.error, REFRESH_VERB_ID));
  const jiraNames = new Set([
    ...FIXED_COLUMNS.map((column) => column.name),
    ...mapped.value.map(({ column }) => column),
  ]);
  if (by !== undefined && by.name !== 'key' && jiraNames.has(by.name.toLowerCase())) {
    return refused(
      problem(`by= names ${by.name}, a column this verb writes; name key or a column of your own`),
    );
  }

  const keyOf = (row: Row): string | undefined => {
    const value = by === undefined ? row.key : row.values[by.name];
    const key = typeof value === 'string' ? value.trim() : undefined;
    return key !== undefined && ISSUE_KEY.test(key) ? key : undefined;
  };
  const keys = [
    ...new Set(
      table.rows
        .filter((row) => only === undefined || row.values[only.name] === true)
        .map(keyOf)
        .filter((key): key is string => key !== undefined),
    ),
  ];
  if (keys.length > MAX_KEYS) {
    return refused(
      narrow(
        `would refresh ${issueCount(keys.length)}, more than the ${count(MAX_KEYS)} one call takes`,
      ),
    );
  }

  const config = await resolveJiraConfig(host, request.section);
  if (!config.ok) return refused(verbFailed(config.error, REFRESH_VERB_ID));
  const deadline = clock.now() + BUDGET_MILLISECONDS;
  let overBudget = false;
  const client = createJiraClient({
    config: config.value,
    fetch: (url, init) => {
      if (clock.now() > deadline) {
        overBudget = true;
        return Promise.reject(new Error('the refresh ran out of time'));
      }
      return host.fetch(url, init);
    },
    sleep: async (milliseconds) => {
      if (clock.now() + milliseconds > deadline) overBudget = true;
      else await (clock.sleep ?? wait)(milliseconds);
    },
  });
  const jiraFailed = (error: JiraError): TransformAnswer =>
    overBudget
      ? refused(
          narrow(
            `did not finish ${issueCount(keys.length)} within ${BUDGET_MILLISECONDS / 1000} s`,
          ),
        )
      : refused(verbFailed(error, REFRESH_VERB_ID));

  const types = await mappedTypes(client, mapped.value);
  if (!types.ok) return jiraFailed(types.error);
  const targets = [...FIXED_COLUMNS, ...mappedColumns(mapped.value, types.value)];
  const existing = new Map(table.columns.map((column) => [column.name.toLowerCase(), column]));
  for (const target of targets) {
    const column = existing.get(target.name);
    if (column !== undefined && column.type !== target.type) {
      return refused(
        problem(
          `would write ${target.type} column ${target.name}, and the table's ${column.name} is ` +
            `${column.type}; rename it before this step`,
        ),
      );
    }
  }

  const fields = [...new Set([...FIXED_FIELDS, ...mapped.value.map(({ id }) => id)])];
  const found = await fetchIssues(client, keys, fields);
  if (!found.ok) return jiraFailed(found.error);
  const issues = new Map<string, PulledIssue>();
  for (const issue of found.value.values()) issues.set(issue.key, issue);
  if (children) {
    const parents = [...new Set([...found.value.values()].map((issue) => issue.key))];
    const read = await childrenOf(client, parents, fields);
    if (!read.ok) return jiraFailed(read.error);
    if (read.value === 'too many') {
      return refused(
        narrow(`found more than ${count(MAX_CHILDREN)} children of ${issueCount(parents.length)}`),
      );
    }
    for (const child of read.value) if (!issues.has(child.key)) issues.set(child.key, child);
  }

  const ordered = [...issues.values()];
  const read = await readIssues(client, ordered);
  if (!read.ok) return jiraFailed(read.error);
  const fetchedAt = new Date(clock.now()).toISOString();
  const nameOf = (name: string): string => existing.get(name)?.name ?? name;
  const live = new Map<string, Row>();
  for (const [index, issue] of ordered.entries()) {
    const row = issueRow(issue, read.value.comments[index] ?? [], read.value.parents, {
      baseUrl: config.value.baseUrl,
      fetchedAt,
      mapped: mapped.value,
      types: types.value,
    });
    if (!row.ok) return jiraFailed(row.error);
    const values: Record<string, CellValue> = {};
    for (const [name, value] of Object.entries(row.value.values)) values[nameOf(name)] = value;
    live.set(issue.key, {
      key: issue.key,
      values,
      provenance: { source: REFRESH_VERB_ID, id: issue.key, fetchedAt },
    });
  }

  const added = targets.filter((target) => !existing.has(target.name));
  const addedNulls = Object.fromEntries(added.map((column) => [column.name, null]));
  const jiraNulls = Object.fromEntries(targets.map((column) => [nameOf(column.name), null]));
  const askedKeys = new Set(keys);
  const rowKeys = new Set(table.rows.map((row) => row.key));
  const present = new Set<string>();
  const rows: Row[] = table.rows.map((row) => {
    const key = keyOf(row);
    if (key === undefined) return { ...row, values: { ...addedNulls, ...row.values } };
    const issue = found.value.get(key) ?? issues.get(key);
    const fresh = issue === undefined ? undefined : live.get(issue.key);
    if (fresh !== undefined) {
      present.add(fresh.key);
      return { ...row, values: { ...row.values, ...fresh.values }, provenance: fresh.provenance };
    }
    if (!askedKeys.has(key)) return { ...row, values: { ...addedNulls, ...row.values } };
    // Asked for and gone: deleted, or hidden from the account. The row stays, so a recipe
    // can see it went, with nothing of Jira's but the key it was found by.
    const values: Record<string, CellValue> = { ...row.values, ...jiraNulls };
    if (by !== undefined) values[by.name] = row.values[by.name] ?? null;
    return { ...row, values };
  });

  const emptyRow = Object.fromEntries(
    [...table.columns.map((column) => column.name), ...added.map((column) => column.name)].map(
      (name) => [name, null],
    ),
  );
  for (const [key, fresh] of live) {
    if (present.has(key)) continue;
    if (rowKeys.has(key)) {
      return refused(
        problem(
          `would add child ${key}, which is already the key of a row with another ` +
            `${by?.name ?? 'key'}; two rows cannot share a key`,
        ),
      );
    }
    const values: Record<string, CellValue> = { ...emptyRow, ...fresh.values };
    if (by !== undefined) values[by.name] = key;
    rows.push({ ...fresh, values });
  }
  return { ok: true, value: { columns: [...table.columns, ...added], rows }, diagnostics: [] };
}

interface RefreshArguments {
  readonly by: Column | undefined;
  readonly only: Column | undefined;
  readonly children: boolean;
}

function readArguments(request: TransformRequest): RefreshArguments | Diagnostic {
  const columns = new Map(
    request.table.columns.map((column) => [column.name.toLowerCase(), column]),
  );
  const columnOf = (name: 'by' | 'only'): Column | Diagnostic | undefined => {
    const written = request.arguments[name];
    if (written === undefined) return undefined;
    const column = columns.get(String(written).trim().toLowerCase());
    return (
      column ?? problem(`${name}= names '${String(written)}', which is not a column of the table`)
    );
  };
  const by = columnOf('by');
  if (by !== undefined && 'severity' in by) return by;
  if (by !== undefined && by.type !== 'text') {
    return problem(`by= names ${by.name}, a ${by.type} column; an issue key is text`);
  }
  const only = columnOf('only');
  if (only !== undefined && 'severity' in only) return only;
  if (only !== undefined && only.type !== 'boolean') {
    return problem(
      `only= names ${only.name}, a ${only.type} column; name a true or false one, such as recall's mark=`,
    );
  }
  return { by, only, children: request.arguments['children'] === true };
}

/**
 * Each key's issue, by the key it was asked by. One that `bulkfetch` answered under another key
 * (moved to another project) and did not refuse is read on its own, which Jira answers under
 * its key now. One Jira refuses, or answers 404 for, is absent.
 */
async function fetchIssues(
  client: JiraClient,
  keys: readonly string[],
  fields: readonly string[],
): Promise<JiraResult<ReadonlyMap<string, PulledIssue>>> {
  const answered = await bulkIssues(client, keys, fields);
  if (!answered.ok) return answered;
  const byKey = new Map(answered.value.issues.map((issue) => [issue.key, issue]));
  const found = new Map<string, PulledIssue>();
  for (const key of keys) {
    const issue = byKey.get(key);
    if (issue !== undefined) {
      found.set(key, issue);
      continue;
    }
    if (answered.value.refused.has(key)) continue;
    const path = `/rest/api/3/issue/${encodeURIComponent(key)}`;
    const single = await client.get(path, { fields: fields.join(',') });
    if (!single.ok) {
      if (single.error.status === 404) continue;
      return single;
    }
    const moved = issueOf(single.value);
    if (moved === undefined) {
      return jiraError(
        'E_JIRA_RESPONSE',
        `GET ${path} answered an issue without an id, a key or fields.`,
      );
    }
    found.set(key, moved);
  }
  return jiraOk(found);
}

/** Every child of the parents, by `parent in (...)`, or `'too many'` past {@link MAX_CHILDREN}. */
async function childrenOf(
  client: JiraClient,
  parents: readonly string[],
  fields: readonly string[],
): Promise<JiraResult<readonly PulledIssue[] | 'too many'>> {
  const children: PulledIssue[] = [];
  for (let start = 0; start < parents.length; start += PARENTS_PER_SEARCH) {
    const jql = `parent in (${parents.slice(start, start + PARENTS_PER_SEARCH).join(', ')}) ORDER BY key ASC`;
    let token: string | undefined;
    for (;;) {
      const page = await searchPage(client, jql, fields, token);
      if (!page.ok) return page;
      children.push(...page.value.issues);
      if (children.length > MAX_CHILDREN) return jiraOk('too many');
      const next = page.value.nextPageToken;
      if (page.value.isLast || next === undefined) break;
      if (next === token) {
        return jiraError('E_JIRA_RESPONSE', 'the children search answered the token it was given.');
      }
      token = next;
    }
  }
  return jiraOk(children);
}

function problem(text: string): Diagnostic {
  return argumentsProblem(text, REFRESH_VERB_ID);
}

/** Past a ceiling: an error at a known number, never a partial table. */
function narrow(what: string): Diagnostic {
  return {
    severity: 'error',
    code: 'E_RECIPE_VERB',
    message: `'${REFRESH_VERB_ID}' ${what}; narrow it with only=.`,
  };
}

function refused(diagnostic: Diagnostic): TransformAnswer {
  return { ok: false, error: [diagnostic] };
}

function issueCount(value: number): string {
  return `${count(value)} ${value === 1 ? 'issue' : 'issues'}`;
}

function count(value: number): string {
  return value.toLocaleString('en-US');
}

const wait = (milliseconds: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, milliseconds));
