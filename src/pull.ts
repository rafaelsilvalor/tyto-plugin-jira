import type { PluginHost, RecipeVerbContribution } from '@tyto/plugin-api';

import { readCache, recordingClient, replayingClient, writeCache, type PageCall } from './cache.js';
import { FIXED_COLUMNS, FIXED_FIELDS } from './columns.js';
import { resolveJiraConfig } from './config.js';
import { decodeCursor, encodeCursor, fingerprint, type PullCursor } from './cursor.js';
import {
  VERB_ID,
  argumentsProblem,
  failed,
  verbFailed,
  type ArgumentSpec,
  type ArgumentValues,
  type Diagnostic,
  type PageAnswer,
  type PageRequest,
  type Row,
} from './diagnostics.js';
import type { JiraResult } from './errors.js';
import {
  mappedColumns,
  mappedFields,
  mappedTypes,
  sameColumns,
  type MappedTypes,
} from './fields.js';
import { createJiraClient, type JiraClient } from './http.js';
import { issueRow, readIssues, type IssuesRead } from './rows.js';
import { PAGE_SIZE, jqlOf, searchPage, type SearchPage, type Selector } from './search.js';

export const DEFAULT_MAX = 10_000;
export const MAX_MAX = 100_000;

const SELECTORS = ['jql', 'board', 'keys', 'parent'] as const;
export const ISSUE_KEY = /^[A-Z][A-Z0-9_]+-\d+$/;

const ARGUMENTS: readonly ArgumentSpec[] = [
  { name: 'jql', type: 'text' },
  { name: 'board', type: 'number' },
  { name: 'keys', type: 'text' },
  { name: 'parent', type: 'text' },
  { name: 'max', type: 'number' },
];

/** The parts of the host a pull uses. */
export type PullHost = Pick<PluginHost, 'config' | 'credentials' | 'fetch' | 'cache' | 'log'>;

/**
 * `jira.pull`: issues by JQL, a board, a list of keys or a parent, one search page per call,
 * as a table with the fifteen fixed columns and the `fields:` section's mapped ones. The host
 * loops over the pages (ADR 0128), so each call is one search plus what its rows need:
 * overflowing comments and missing parents — or none of them, when the cache holds the page.
 */
export function pullVerb(host: PullHost): RecipeVerbContribution {
  return {
    id: VERB_ID,
    kind: 'source',
    arguments: ARGUMENTS,
    page: (request) => pullPage(host, request),
  };
}

interface PullRequest {
  readonly selector: Selector;
  readonly max: number;
}

export async function pullPage(host: PullHost, request: PageRequest): Promise<PageAnswer> {
  const asked = readRequest(request.arguments);
  if ('severity' in asked) return failed(asked);
  let cursor: PullCursor | undefined;
  if (request.cursor !== undefined) {
    const decoded = decodeCursor(request.cursor);
    if (typeof decoded === 'string') {
      return failed({
        severity: 'error',
        code: 'E_RECIPE_VERB',
        message: `'${VERB_ID}' failed: ${decoded}; run again.`,
      });
    }
    cursor = decoded;
  }

  const config = await resolveJiraConfig(host, request.section);
  if (!config.ok) return failed(verbFailed(config.error));
  const mapped = mappedFields(request.section);
  if (!mapped.ok) return failed(verbFailed(mapped.error));
  const client = createJiraClient({
    fetch: (url, init) => host.fetch(url, init),
    config: config.value,
  });

  const jql = await jqlOf(client, asked.selector);
  if (!jql.ok) return failed(verbFailed(jql.error));
  const fields = [...new Set([...FIXED_FIELDS, ...mapped.value.map(({ id }) => id)])];
  const requestPrint = fingerprint(
    JSON.stringify([config.value.baseUrl, jql.value, fields, mapped.value]),
  );
  const changed = verbFailed({
    code: 'E_JIRA_CONFIG',
    message: 'the jira section changed during the pull; run again',
  });
  if (cursor !== undefined && cursor.f !== requestPrint) return failed(changed);

  let types: MappedTypes;
  if (cursor === undefined) {
    const read = await mappedTypes(client, mapped.value);
    if (!read.ok) return failed(verbFailed(read.error));
    types = read.value;
  } else {
    if (!sameColumns(cursor.m, mapped.value)) return failed(changed);
    types = cursor.m;
  }

  const call: PageCall = {
    baseUrl: config.value.baseUrl,
    email: config.value.email,
    jql: jql.value,
    fields,
    pageSize: PAGE_SIZE,
    token: cursor?.t,
    page: cursor?.p ?? 1,
  };
  const now = Date.now();
  let read: PageRead | undefined;
  let generation = cursor?.g ?? now;
  let fetchedAt = new Date(now).toISOString();
  let fromCache = false;
  // A run asked to be fresh skips reading the cache, and still fills it for the next run.
  const cached = request.refresh === true ? undefined : await readCache(host, call, cursor?.g, now);
  if (cached !== undefined) {
    const replayed = await readPage(replayingClient(cached.raw), call);
    if (replayed.ok) {
      read = replayed.value;
      generation = cached.gen;
      fetchedAt = cached.storedAt;
      fromCache = true;
    }
  }
  if (read === undefined) {
    const recorder = recordingClient(client);
    const live = await readPage(recorder.client, call);
    if (!live.ok) return failed(verbFailed(live.error));
    read = live.value;
    await writeCache(host, call, generation, recorder.raw());
  }

  const rows: Row[] = [];
  for (const [index, issue] of read.page.issues.entries()) {
    const row = issueRow(issue, read.comments[index] ?? [], read.parents, {
      baseUrl: config.value.baseUrl,
      fetchedAt,
      mapped: mapped.value,
      types,
    });
    if (!row.ok) return failed(verbFailed(row.error));
    rows.push(row.value);
  }

  const table = { columns: [...FIXED_COLUMNS, ...mappedColumns(mapped.value, types)], rows };
  const { isLast, nextPageToken } = read.page;
  const total = (cursor?.n ?? 0) + rows.length;
  // Never a partial table: Jira saying "more" with no way on, or more rows than `max=` allows,
  // is a page cut short, and the host turns that into an error rather than a short table.
  const truncated =
    total > asked.max ||
    (!isLast && total === asked.max) ||
    (!isLast && nextPageToken === undefined);
  if (truncated) return { ok: true, value: { table, truncated: true }, diagnostics: [] };
  if (isLast || nextPageToken === undefined) return { ok: true, value: { table }, diagnostics: [] };
  // Jira answering the token it was just given would loop for ever. Handing back the cursor
  // the host just gave lets the host's own repeated-cursor check refuse it.
  if (cursor !== undefined && request.cursor !== undefined && nextPageToken === cursor.t) {
    return { ok: true, value: { table, cursor: request.cursor }, diagnostics: [] };
  }
  const next = encodeCursor({
    v: 1,
    t: nextPageToken,
    n: total,
    p: (cursor?.p ?? 1) + 1,
    f: requestPrint,
    m: types,
    g: generation,
    c: fromCache,
  });
  return { ok: true, value: { table, cursor: next }, diagnostics: [] };
}

/** What one page is made of, live or replayed from the cache. */
interface PageRead extends IssuesRead {
  readonly page: SearchPage;
}

/** The search page and what its rows need, through whichever client is handed. */
async function readPage(client: JiraClient, call: PageCall): Promise<JiraResult<PageRead>> {
  const page = await searchPage(client, call.jql, call.fields, call.token);
  if (!page.ok) return page;
  const read = await readIssues(client, page.value.issues);
  if (!read.ok) return read;
  return { ok: true, value: { page: page.value, ...read.value } };
}

/** The selector and `max=`, or what is wrong with the step's arguments. */
export function readRequest(values: ArgumentValues): PullRequest | Diagnostic {
  const given = SELECTORS.filter((name) => values[name] !== undefined);
  if (given.length === 0) {
    return argumentsProblem('needs one of jql=, board=, keys= or parent=, and was given none');
  }
  if (given.length > 1) {
    return argumentsProblem(
      `takes one of jql=, board=, keys= or parent=, and was given ${given.map((name) => `${name}=`).join(' and ')}`,
    );
  }
  const max = values['max'] ?? DEFAULT_MAX;
  if (typeof max !== 'number' || !Number.isSafeInteger(max) || max < 1 || max > MAX_MAX) {
    return argumentsProblem(`max= must be a whole number from 1 to ${MAX_MAX}, not ${String(max)}`);
  }
  const selector = selectorOf(given[0] ?? 'jql', values);
  return 'severity' in selector ? selector : { selector, max };
}

function selectorOf(
  name: (typeof SELECTORS)[number],
  values: ArgumentValues,
): Selector | Diagnostic {
  const value = values[name];
  if (name === 'board') {
    return typeof value === 'number' && Number.isSafeInteger(value) && value > 0
      ? { kind: 'board', board: value }
      : argumentsProblem(`board= must be a board's number, such as board=12, not ${String(value)}`);
  }
  const written = String(value).trim();
  if (name === 'jql') {
    return written === ''
      ? argumentsProblem('jql= is empty; write a query, such as jql="project = EX"')
      : { kind: 'jql', jql: written };
  }
  if (name === 'parent') {
    return ISSUE_KEY.test(written)
      ? { kind: 'parent', key: written }
      : argumentsProblem(`parent= holds '${written}', which is not one issue key, such as EX-1`);
  }
  const keys = written.split(',').map((key) => key.trim());
  const bad = keys.find((key) => !ISSUE_KEY.test(key));
  if (bad !== undefined) {
    return argumentsProblem(
      `keys= holds '${bad}', which is not an issue key; write keys such as keys="EX-1,EX-2"`,
    );
  }
  return { kind: 'keys', keys: [...new Set(keys)] };
}
