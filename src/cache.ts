import type { PluginHost } from '@tyto/plugin-api';

import { record } from './columns.js';
import { fingerprint } from './cursor.js';
import { jiraError, jiraOk, messageOf, type JiraResult } from './errors.js';
import type { JiraAccount, JiraClient, JiraQuery } from './http.js';

/**
 * The private cache of `jira.pull`'s pages (Tyto ADR 0138), so running a recipe again within
 * minutes asks Jira nothing.
 *
 * **Only Jira's raw answers are kept**: the search page, the comment pages and the parents'
 * bulk fetch, never the rows made from them. A hit replays them through the same code a live
 * page runs, so a cached page and a live one are the same table by construction.
 *
 * **The cache never fails a pull.** A host with no cache, a refused key, an entry over the
 * host's 32 MiB or one that is not this plugin's shape is a warning in the log and a live page.
 */

/** How long a page stays fresh, by the host's own `storedAt`. */
export const FRESH_MILLISECONDS = 10 * 60 * 1000;
/** The host's ceiling on one entry (Tyto ADR 0138), written here to keep the bundle import-free. */
export const ENTRY_LIMIT_BYTES = 32 * 1024 * 1024;

const SEARCH_PATH = '/rest/api/3/search/jql';
const BULK_PATH = '/rest/api/3/issue/bulkfetch';
const COMMENT_PATH = /^\/rest\/api\/3\/issue\/([^/]+)\/comment$/;

/** The parts of the host the cache uses. */
export type CacheHost = Pick<PluginHost, 'cache' | 'log'>;

/** Jira's answers for one page, as they came. */
export interface RawPage {
  readonly search: unknown;
  /** Each issue's comment pages, by issue key, in the order they were read. */
  readonly comments: Readonly<Record<string, readonly unknown[]>>;
  /** The parents' bulk fetch, or `null` when the page needed none. */
  readonly parents: unknown;
}

interface CacheEntry {
  readonly v: 1;
  readonly request: string;
  readonly gen: number;
  readonly raw: RawPage;
}

/** Everything a page's answer depends on, besides the account. */
export interface PageCall {
  readonly baseUrl: string;
  readonly email: string;
  readonly jql: string;
  readonly fields: readonly string[];
  readonly pageSize: number;
  /** Jira's token for this page; absent on the first. */
  readonly token: string | undefined;
  readonly page: number;
}

/**
 * `jira/pull/v1/<site host>/<fnv(email)>/<fnv(request)>/<page>`. The email is hashed, so the
 * cache's sidecar never holds an address, and the token is not in the key at all: Jira's page
 * token changes from run to run, so the key names the page's slot and the entry's full
 * request, token included, says whether it is the same page.
 */
export function cacheKey(call: PageCall): string {
  const host = new URL(call.baseUrl).host;
  const request = fingerprint(JSON.stringify([call.jql, call.fields, call.pageSize]));
  return `jira/pull/v1/${host}/${fingerprint(call.email)}/${request}/${call.page}`;
}

/** The request an entry must have been made by to answer this call. */
export function canonicalRequest(call: PageCall): string {
  return JSON.stringify({
    site: call.baseUrl,
    jql: call.jql,
    fields: call.fields,
    pageSize: call.pageSize,
    token: call.token ?? null,
  });
}

export interface CachedPage {
  readonly raw: RawPage;
  readonly gen: number;
  readonly storedAt: string;
}

/**
 * The fresh entry this exact request stored, or `undefined`. `generation` is the cursor's: a
 * later page is only taken from the cache when the first page was the same fill, so one
 * table is never stitched from two runs of Jira.
 */
export async function readCache(
  host: CacheHost,
  call: PageCall,
  generation: number | undefined,
  now: number,
): Promise<CachedPage | undefined> {
  let stored;
  try {
    stored = await host.cache.get(cacheKey(call));
  } catch (thrown) {
    host.log.warn(`jira.pull read no cache: ${messageOf(thrown)}`);
    return undefined;
  }
  if (stored === undefined) return undefined;
  if (stored.bytes.byteLength > ENTRY_LIMIT_BYTES) {
    host.log.warn(`jira.pull ignored a cache entry of ${stored.bytes.byteLength} bytes`);
    return undefined;
  }
  const entry = entryOf(stored.bytes);
  if (entry === undefined) {
    host.log.warn('jira.pull ignored a cache entry it did not write');
    return undefined;
  }
  const age = now - Date.parse(stored.storedAt);
  if (!(age >= 0 && age < FRESH_MILLISECONDS)) return undefined;
  if (entry.request !== canonicalRequest(call)) return undefined;
  if (generation !== undefined && entry.gen !== generation) return undefined;
  return { raw: entry.raw, gen: entry.gen, storedAt: stored.storedAt };
}

/** Stores a page's raw answers; a refusal is a warning, never the pull's failure. */
export async function writeCache(
  host: CacheHost,
  call: PageCall,
  generation: number,
  raw: RawPage,
): Promise<void> {
  const entry: CacheEntry = { v: 1, request: canonicalRequest(call), gen: generation, raw };
  const bytes = new TextEncoder().encode(JSON.stringify(entry));
  if (bytes.byteLength > ENTRY_LIMIT_BYTES) {
    host.log.warn(`jira.pull cached no page of ${bytes.byteLength} bytes, over the host's limit`);
    return;
  }
  try {
    await host.cache.put(cacheKey(call), bytes);
  } catch (thrown) {
    host.log.warn(`jira.pull cached nothing: ${messageOf(thrown)}`);
  }
}

function entryOf(bytes: Uint8Array): CacheEntry | undefined {
  let parsed: unknown;
  try {
    parsed = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
  } catch {
    return undefined;
  }
  const entry = record(parsed);
  const raw = record(entry?.['raw']);
  const comments = record(raw?.['comments']);
  if (
    entry?.['v'] !== 1 ||
    typeof entry['request'] !== 'string' ||
    !Number.isSafeInteger(entry['gen']) ||
    raw === undefined ||
    !('search' in raw) ||
    comments === undefined ||
    !Object.values(comments).every((pages) => Array.isArray(pages))
  ) {
    return undefined;
  }
  return parsed as CacheEntry;
}

/** A client that records the answers a page reads, and the record so far. */
export function recordingClient(client: JiraClient): {
  readonly client: JiraClient;
  readonly raw: () => RawPage;
} {
  let search: unknown = null;
  let parents: unknown = null;
  const comments: Record<string, unknown[]> = {};
  const kept = (path: string, value: unknown): void => {
    const comment = COMMENT_PATH.exec(path)?.[1];
    if (path === SEARCH_PATH) search = value;
    else if (path === BULK_PATH) parents = value;
    else if (comment !== undefined) (comments[comment] ??= []).push(value);
  };
  return {
    client: {
      async get(path, query) {
        const answer = await client.get(path, query);
        if (answer.ok) kept(path, answer.value);
        return answer;
      },
      async post(path, body) {
        const answer = await client.post(path, body);
        if (answer.ok) kept(path, answer.value);
        return answer;
      },
      myself: () => client.myself(),
    },
    raw: () => ({ search, comments, parents }),
  };
}

/** What a replaying client answers for a request its record does not hold. */
export const NOT_RECORDED = 'not in the cached page';

/**
 * A client that answers from a page's record and never reaches Jira. A request the record
 * does not hold fails with {@link NOT_RECORDED}, and the page is then read live.
 */
export function replayingClient(raw: RawPage): JiraClient {
  const read: Record<string, number> = {};
  const missing = (): JiraResult<never> => jiraError('E_JIRA_RESPONSE', NOT_RECORDED);
  const answer = (path: string): JiraResult<unknown> => {
    if (path === SEARCH_PATH) return jiraOk(raw.search);
    if (path === BULK_PATH) return raw.parents === null ? missing() : jiraOk(raw.parents);
    const key = COMMENT_PATH.exec(path)?.[1];
    if (key === undefined) return missing();
    const index = read[key] ?? 0;
    read[key] = index + 1;
    const pages = raw.comments[key];
    return pages !== undefined && index < pages.length ? jiraOk(pages[index]) : missing();
  };
  return {
    get: async (path: string, _query?: JiraQuery) => answer(path),
    post: async (path: string) => answer(path),
    myself: async (): Promise<JiraResult<JiraAccount>> => missing(),
  };
}
