import type { PluginHost, RecipeVerbContribution } from '@tyto/plugin-api';

import { FIXED_COLUMNS, FIXED_FIELDS, record, type PulledIssue } from './columns.js';
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
import { chosenBy, mappedColumns, mappedFields, mappedTypes } from './fields.js';
import { createJiraClient, type JiraClient } from './http.js';
import { ISSUE_KEY } from './pull.js';
import { issueRow, readIssues } from './rows.js';
import { bulkIssues, issueOf, searchPage } from './search.js';

/** Issues one call refreshes at most: ten `bulkfetch` requests. */
export const MAX_KEYS = 1_000;
/** Children `children=true` adds at most, and sisters `sisters=`: a hundred search pages. */
export const MAX_CHILDREN = 5_000;
/** How long one call may spend, under the host's 30 s deadline with room to answer. */
export const BUDGET_MILLISECONDS = 25_000;
/** Parent keys per `parent in (...)` search, so the JQL stays short. */
const PARENTS_PER_SEARCH = 100;

const ARGUMENTS: readonly ArgumentSpec[] = [
  { name: 'by', type: 'text' },
  { name: 'only', type: 'text' },
  { name: 'children', type: 'boolean' },
  { name: 'prefix', type: 'text' },
  { name: 'sisters', type: 'text' },
  { name: 'sisters-jql', type: 'text' },
];

/** A prefix is a start of a column name: letters, digits and underscores, a letter first. */
const PREFIX = /^[A-Za-z][A-Za-z0-9_]*$/;

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
 * `jira.refresh [by=<column>] [only=<boolean column>] [children=true] [prefix=<text>]
 * [sisters=<issue type> [sisters-jql=<clause>]]`: the
 * table it is handed, with every row that names an issue filled with what Jira holds now, in the
 * columns `jira.pull` answers. With `prefix=jira_`, those columns are `jira_status`, `jira_key`
 * and so on, so a sheet column of the same name (`status`) keeps the person's value. It is how a row `recall` brought back gets its current values
 * (Tyto ADR 0144), and with `children=true`, how `rollup` sees every child of a parent. With
 * `sisters=COPYWRITER`, the other issues of that type under each refreshed issue's parent come
 * as rows too, so Tyto's `nearest ... within=parent_key` can pick one for each row.
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
  const { by, only, children, prefix, sisters } = asked;
  const mapped = mappedFields(request.section);
  if (!mapped.ok) return refused(verbFailed(mapped.error, REFRESH_VERB_ID));
  /** The name this step writes a Jira column under. */
  const written = (name: string): string => `${prefix}${name}`;
  const jiraNames = new Set(
    [
      ...FIXED_COLUMNS.map((column) => column.name),
      ...mapped.value.map(({ column }) => column),
    ].map((name) => written(name).toLowerCase()),
  );
  const writtenKey = written('key').toLowerCase();
  const byName = by?.name.toLowerCase();
  if (byName !== undefined && byName !== writtenKey && jiraNames.has(byName)) {
    return refused(
      problem(
        `by= names ${by?.name ?? byName}, a column this verb writes; name key or a column of your own`,
      ),
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
        .filter((row) => only === undefined || chosenBy(row, only))
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
  const targets = [...FIXED_COLUMNS, ...mappedColumns(mapped.value, types.value)].map((column) => ({
    ...column,
    name: written(column.name),
  }));
  const existing = new Map(table.columns.map((column) => [column.name.toLowerCase(), column]));
  for (const target of targets) {
    const column = existing.get(target.name.toLowerCase());
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
    const read = await childrenOf(client, parents, fields, '');
    if (!read.ok) return jiraFailed(read.error);
    if (read.value === 'too many') {
      return refused(
        narrow(`found more than ${count(MAX_CHILDREN)} children of ${issueCount(parents.length)}`),
      );
    }
    for (const child of read.value) if (!issues.has(child.key)) issues.set(child.key, child);
  }
  if (sisters !== undefined) {
    const parents = [
      ...new Set(
        [...found.value.values()]
          .map((issue) => record(issue.fields['parent'])?.['key'])
          .filter((key): key is string => typeof key === 'string' && ISSUE_KEY.test(key)),
      ),
    ];
    const read = await childrenOf(client, parents, fields, sisterFilter(sisters));
    if (!read.ok) return jiraFailed(read.error);
    if (read.value === 'too many') {
      return refused(
        narrow(
          `found more than ${count(MAX_CHILDREN)} sisters under ` +
            `${parents.length === 1 ? '1 parent' : `${count(parents.length)} parents`}`,
        ),
      );
    }
    // A row's own issue comes back among its parent's children when it has the type asked for.
    // It keeps what bulkfetch read, which Jira answers from the issue itself, while a search
    // answers from an index that can lag behind it.
    const tableIssues = new Set(table.rows.map(keyOf));
    const rowKeysNow = new Set(table.rows.map((row) => row.key));
    for (const sister of read.value) {
      if (issues.has(sister.key)) continue;
      // A row keyed by this issue that by= reads another issue for is not this sister's row:
      // adding the sister would give two rows one key.
      if (rowKeysNow.has(sister.key) && !tableIssues.has(sister.key)) continue;
      issues.set(sister.key, sister);
    }
  }

  const ordered = [...issues.values()];
  const read = await readIssues(client, ordered);
  if (!read.ok) return jiraFailed(read.error);
  const fetchedAt = new Date(clock.now()).toISOString();
  const nameOf = (name: string): string => existing.get(name.toLowerCase())?.name ?? name;
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
    for (const [name, value] of Object.entries(row.value.values)) {
      values[nameOf(written(name))] = value;
    }
    live.set(issue.key, {
      key: issue.key,
      values,
      provenance: { source: REFRESH_VERB_ID, id: issue.key, fetchedAt },
    });
  }

  const added = targets.filter((target) => !existing.has(target.name.toLowerCase()));
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
  /** What every column this step writes starts with; empty without `prefix=`. */
  readonly prefix: string;
  /** The sisters to add: their issue type, and a JQL clause they also meet. */
  readonly sisters: SisterFilter | undefined;
}

interface SisterFilter {
  readonly issueType: string;
  readonly jql: string | undefined;
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
  const prefix = request.arguments['prefix'];
  if (prefix !== undefined && !PREFIX.test(String(prefix).trim())) {
    return problem(
      `prefix= is '${String(prefix)}'; a prefix is letters, digits and underscores, a letter ` +
        'first, such as jira_',
    );
  }
  const sisterType = request.arguments['sisters'];
  const sisterJql = request.arguments['sisters-jql'];
  if (sisterType !== undefined && String(sisterType).trim() === '') {
    return problem('sisters= is empty; name the issue type of the sisters, such as COPYWRITER');
  }
  if (sisterJql !== undefined && sisterType === undefined) {
    return problem('sisters-jql= narrows sisters=; name the issue type with sisters= too');
  }
  if (sisterJql !== undefined && String(sisterJql).trim() === '') {
    return problem('sisters-jql= is empty; write a JQL clause, or leave it out');
  }
  return {
    by,
    only,
    children: request.arguments['children'] === true,
    prefix: prefix === undefined ? '' : String(prefix).trim(),
    sisters:
      sisterType === undefined
        ? undefined
        : {
            issueType: String(sisterType).trim(),
            jql: sisterJql === undefined ? undefined : String(sisterJql).trim(),
          },
  };
}

/** What a sisters search adds after `parent in (...)`: the type, quoted, and the clause. */
function sisterFilter({ issueType, jql }: SisterFilter): string {
  const quoted = `"${issueType.replace(/["\\]/g, (character) => '\\' + character)}"`;
  return ` AND issuetype = ${quoted}${jql === undefined ? '' : ` AND (${jql})`}`;
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

/**
 * Every child of the parents that `filter` (JQL after `parent in (...)`, or empty) keeps, by
 * `parent in (...)` a hundred parents at a time, or `'too many'` past {@link MAX_CHILDREN}.
 */
async function childrenOf(
  client: JiraClient,
  parents: readonly string[],
  fields: readonly string[],
  filter: string,
): Promise<JiraResult<readonly PulledIssue[] | 'too many'>> {
  const children: PulledIssue[] = [];
  for (let start = 0; start < parents.length; start += PARENTS_PER_SEARCH) {
    const batch = parents.slice(start, start + PARENTS_PER_SEARCH).join(', ');
    const jql = `parent in (${batch})${filter} ORDER BY key ASC`;
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
