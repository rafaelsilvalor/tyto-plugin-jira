import { readFileSync } from 'node:fs';

import type { FetchedResponse, HostCapabilities, HostFetchInit } from '@tyto/plugin-api';
import { testPlugin, type PluginHarness } from '@tyto/plugin-api/testing';

import { response } from './host.js';

/**
 * A synthetic Jira Cloud site for `jira.pull`, answered through the contract's own harness: the
 * committed `dist/index.js`, activated over the isolation protocol, with the manifest's
 * permissions in front of every request. Nothing here is a real site, key or person.
 */
const manifest = readFileSync(new URL('../tyto-plugin.json', import.meta.url), 'utf8');
const entry = new URL('../dist/index.js', import.meta.url).href;

export const SITE = 'https://example.atlassian.net';
export const TOKEN = 'test-token-not-real';
export const EMAIL = 'person@example.com';

export interface JiraCall {
  readonly method: string;
  readonly path: string;
  readonly query: Readonly<Record<string, string>>;
  readonly body: unknown;
}

/** Answers one call, or `undefined` to let the next route try. */
export type Route = (call: JiraCall) => FetchedResponse | undefined;

export interface FakeSite {
  readonly plugin: PluginHarness;
  readonly calls: readonly JiraCall[];
}

export async function fakeSite(
  routes: readonly Route[],
  options: {
    readonly section?: unknown;
    /** A cache of the test's own, such as {@link memoryCache}'s; absent, the host has none. */
    readonly capabilities?: Partial<HostCapabilities>;
  } = {},
): Promise<FakeSite> {
  const calls: JiraCall[] = [];
  const loaded = await testPlugin({
    manifest,
    load: () => import(entry),
    settings: { 'jira.baseUrl': SITE },
    secrets: { 'api-token': TOKEN, email: EMAIL },
    ...(options.section === undefined ? {} : { section: options.section }),
    ...(options.capabilities === undefined ? {} : { capabilities: options.capabilities }),
    async fetch(url: string, init: HostFetchInit) {
      const parsed = new URL(url);
      const call: JiraCall = {
        method: init.method ?? 'GET',
        path: parsed.pathname,
        query: Object.fromEntries(parsed.searchParams),
        body: typeof init.body === 'string' ? (JSON.parse(init.body) as unknown) : undefined,
      };
      calls.push(call);
      for (const route of routes) {
        const answer = route(call);
        if (answer !== undefined) return answer;
      }
      throw new Error(`no fake route answers ${call.method} ${call.path}`);
    },
  });
  if (!loaded.ok) {
    throw new Error(loaded.error.map((item) => `${item.code}: ${item.message}`).join('\n'));
  }
  return { plugin: loaded.value, calls };
}

/** What a one-step recipe answered: its table, or its diagnostics. */
export async function pull(site: FakeSite, step: string) {
  const run = await site.plugin.runRecipe(step);
  if (!run.ok) throw new Error(run.error.map((item) => item.message).join('\n'));
  const cell = run.value.cells[0];
  return {
    status: cell?.status,
    table: cell?.table,
    diagnostics: (cell?.diagnostics ?? []).map(({ code, message }) => ({ code, message })),
  };
}

/** The search pages, by the `nextPageToken` each is asked with (`''` for the first). */
export function searchPages(pages: Readonly<Record<string, unknown>>): Route {
  return (call) => {
    if (call.method !== 'POST' || call.path !== '/rest/api/3/search/jql') return undefined;
    const token = (call.body as { nextPageToken?: string }).nextPageToken ?? '';
    const page = pages[token];
    if (page === undefined) throw new Error(`no search page for token '${token}'`);
    return typeof page === 'object' && page !== null && 'status' in page
      ? (page as FetchedResponse)
      : response(200, page);
  };
}

export function route(method: string, path: string, body: unknown, status = 200): Route {
  return (call) =>
    call.method === method && call.path === path ? response(status, body) : undefined;
}

/** Plain ADF: a paragraph holding the text, with the URL linked when there is one. */
export function adf(text: string, href?: string): unknown {
  return {
    type: 'doc',
    version: 1,
    content: [
      {
        type: 'paragraph',
        content: [
          {
            type: 'text',
            text,
            ...(href === undefined ? {} : { marks: [{ type: 'link', attrs: { href } }] }),
          },
        ],
      },
    ],
  };
}

/** A synthetic issue, `EX-<n>`, with every field a fixed column reads. */
export function issue(
  n: number,
  fields: Readonly<Record<string, unknown>> = {},
): Readonly<Record<string, unknown>> {
  return {
    id: String(10000 + n),
    key: `EX-${n}`,
    fields: {
      summary: `Issue ${n}`,
      project: { key: 'EX', name: 'Example' },
      issuetype: { name: 'Task' },
      status: {
        name: 'In Progress',
        statusCategory: { name: 'In Progress', key: 'indeterminate' },
      },
      parent: null,
      assignee: { displayName: 'A Person' },
      labels: ['one', 'two'],
      created: '2026-10-01T10:15:30.000-0300',
      updated: '2026-10-02T09:00:00.000+0000',
      description: adf(`See https://docs.example.com/${n}.`),
      comment: { comments: [], total: 0, maxResults: 0, startAt: 0 },
      ...fields,
    },
  };
}

export function page(
  issues: readonly unknown[],
  next?: string,
  isLast = next === undefined,
): Readonly<Record<string, unknown>> {
  return { issues, ...(next === undefined ? {} : { nextPageToken: next }), isLast };
}

/** A host cache in memory, dated by a clock the test moves. */
export interface MemoryCache {
  readonly capabilities: Partial<HostCapabilities>;
  readonly entries: Map<string, { bytes: Uint8Array; storedAt: string }>;
  /** What the host's clock says now; a test sets it. */
  now: string;
  /** The entry under a key, decoded. */
  entry(key: string): Record<string, unknown>;
}

export function memoryCache(): MemoryCache {
  const entries = new Map<string, { bytes: Uint8Array; storedAt: string }>();
  const cache: MemoryCache = {
    entries,
    now: new Date().toISOString(),
    capabilities: {
      cacheGet: async (_plugin, key) => entries.get(key),
      async cachePut(_plugin, key, bytes) {
        entries.set(key, { bytes, storedAt: cache.now });
        return { storedAt: cache.now };
      },
      cacheDelete: async (_plugin, key) => entries.delete(key),
      cacheList: async (_plugin, prefix) =>
        [...entries]
          .filter(([key]) => key.startsWith(prefix))
          .map(([key, { bytes, storedAt }]) => ({ key, storedAt, size: bytes.byteLength })),
    },
    entry(key) {
      const stored = entries.get(key);
      if (stored === undefined) throw new Error(`no cache entry ${key}`);
      return JSON.parse(new TextDecoder().decode(stored.bytes)) as Record<string, unknown>;
    },
  };
  return cache;
}

/** `jira.pull`'s `page`, called as the host's loop calls it, for what a recipe cannot say. */
export function pullVerbOf(site: FakeSite) {
  const verb = site.plugin.host.registry.recipeVerbs().find((each) => each.id === 'jira.pull');
  if (verb?.page === undefined) throw new Error('jira.pull is not registered');
  return verb.page;
}
