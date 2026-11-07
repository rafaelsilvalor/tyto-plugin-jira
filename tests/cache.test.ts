import { afterEach, describe, expect, it } from 'vitest';

import {
  ENTRY_LIMIT_BYTES,
  FRESH_MILLISECONDS,
  readCache,
  writeCache,
  type CacheHost,
  type PageCall,
} from '../src/cache.js';
import {
  EMAIL,
  fakeSite,
  issue,
  memoryCache,
  page,
  pull,
  pullVerbOf,
  searchPages,
  TOKEN,
  type FakeSite,
  type MemoryCache,
} from './jira.js';

/**
 * The private cache of `jira.pull`'s pages, through the committed bundle and a host cache in
 * memory whose clock the test moves.
 */
let open: FakeSite | undefined;
async function site(...args: Parameters<typeof fakeSite>): Promise<FakeSite> {
  await open?.plugin.close();
  open = await fakeSite(...args);
  return open;
}
afterEach(async () => {
  await open?.plugin.close();
  open = undefined;
});

const JQL = 'jira.pull jql="project = EX"';
const PAGES = { '': page([issue(1), issue(2)], 'token-2'), 'token-2': page([issue(3)]) };

const searches = (jira: FakeSite) =>
  jira.calls.filter((call) => call.path === '/rest/api/3/search/jql').length;

/** Runs the two-page pull once into the cache, and answers a fresh site over the same cache. */
async function filled(cache: MemoryCache): Promise<FakeSite> {
  const first = await site([searchPages(PAGES)], { capabilities: cache.capabilities });
  expect((await pull(first, JQL)).diagnostics).toEqual([]);
  expect(searches(first)).toBe(2);
  return site([searchPages(PAGES)], { capabilities: cache.capabilities });
}

function minutesLater(cache: MemoryCache, minutes: number): string {
  return new Date(Date.parse(cache.now) + minutes * 60_000).toISOString();
}

describe('the page cache', () => {
  it('answers a second run from the cache with no request, dated when it was stored', async () => {
    const cache = memoryCache();
    cache.now = new Date(Date.now() - 60_000).toISOString();
    const again = await filled(cache);
    const answer = await pull(again, JQL);
    expect(answer.diagnostics).toEqual([]);
    expect(answer.table?.rows.map((row) => row.key)).toEqual(['EX-1', 'EX-2', 'EX-3']);
    expect(again.calls).toEqual([]);
    expect(answer.table?.rows[0]?.provenance.fetchedAt).toBe(cache.now);
  });

  it('keeps raw answers only, under a key holding neither the token nor the email', async () => {
    const cache = memoryCache();
    await filled(cache);
    const keys = [...cache.entries.keys()];
    expect(keys).toEqual([
      expect.stringMatching(
        /^jira\/pull\/v1\/example\.atlassian\.net\/[0-9a-f]{16}\/[0-9a-f]{16}\/1$/,
      ),
      expect.stringMatching(/\/2$/),
    ]);
    const first = keys[0] ?? '';
    const entry = cache.entry(first);
    expect(Object.keys(entry)).toEqual(['v', 'request', 'gen', 'raw']);
    expect(Object.keys(entry['raw'] as object)).toEqual(['search', 'comments', 'parents']);
    const stored = [...cache.entries].map(
      ([key, { bytes }]) => key + new TextDecoder().decode(bytes),
    );
    expect(stored.join('\n')).not.toContain(TOKEN);
    expect(stored.join('\n')).not.toContain(EMAIL);
  });

  it('reads Jira again when the entry is older than ten minutes', async () => {
    const cache = memoryCache();
    cache.now = new Date(Date.now() - FRESH_MILLISECONDS - 60_000).toISOString();
    const again = await filled(cache);
    const answer = await pull(again, JQL);
    expect(answer.diagnostics).toEqual([]);
    expect(searches(again)).toBe(2);
  });

  it('skips reading the cache on a refresh, and still fills it', async () => {
    const cache = memoryCache();
    const again = await filled(cache);
    const before = [...cache.entries.values()].map((entry) => entry.storedAt);
    cache.now = minutesLater(cache, 1);
    const answer = await pullVerbOf(again)({ arguments: { jql: 'project = EX' }, refresh: true });
    expect(answer.ok).toBe(true);
    expect(searches(again)).toBe(1);
    const first = [...cache.entries.values()][0];
    expect(first?.storedAt).toBe(cache.now);
    expect(first?.storedAt).not.toBe(before[0]);
  });

  it('answers the pull and warns when the host refuses to store', async () => {
    const cache = memoryCache();
    const jira = await site([searchPages(PAGES)], {
      capabilities: {
        ...cache.capabilities,
        cachePut: () => Promise.reject(new Error('the disk is full')),
      },
    });
    const answer = await pull(jira, JQL);
    expect(answer.diagnostics).toEqual([]);
    expect(answer.table?.rows).toHaveLength(3);
    expect(jira.plugin.log.filter((line) => line.includes('cached nothing'))).toHaveLength(2);
    expect(jira.plugin.log.join('\n')).toContain('the disk is full');
  });

  it('answers the pull and warns when the host has no cache at all', async () => {
    const jira = await site([searchPages(PAGES)]);
    const answer = await pull(jira, JQL);
    expect(answer.diagnostics).toEqual([]);
    expect(
      jira.plugin.log.some((line) => line.startsWith('warn: [jira] jira.pull read no cache')),
    ).toBe(true);
  });

  it('reads a later page live when its entry is of another fill than the first page', async () => {
    const cache = memoryCache();
    const again = await filled(cache);
    const second = [...cache.entries.keys()][1] ?? '';
    const entry = cache.entry(second);
    const stored = cache.entries.get(second);
    if (stored === undefined) throw new Error('no second page');
    stored.bytes = new TextEncoder().encode(
      JSON.stringify({ ...entry, gen: (entry['gen'] as number) + 1 }),
    );
    const answer = await pull(again, JQL);
    expect(answer.diagnostics).toEqual([]);
    expect(answer.table?.rows).toHaveLength(3);
    expect(
      again.calls.map((call) => (call.body as { nextPageToken?: string }).nextPageToken),
    ).toEqual(['token-2']);
  });

  it('reads Jira again when the entry was made by another request', async () => {
    const cache = memoryCache();
    const again = await filled(cache);
    const first = [...cache.entries.keys()][0] ?? '';
    const stored = cache.entries.get(first);
    if (stored === undefined) throw new Error('no first page');
    stored.bytes = new TextEncoder().encode(
      JSON.stringify({ ...cache.entry(first), request: '{}' }),
    );
    await pull(again, JQL);
    expect(searches(again)).toBe(2);
  });
});

describe('the cache at its limits', () => {
  const call: PageCall = {
    baseUrl: 'https://example.atlassian.net',
    email: EMAIL,
    jql: 'project = EX',
    fields: ['summary'],
    pageSize: 50,
    token: undefined,
    page: 1,
  };
  function host(bytes: Uint8Array | undefined) {
    const warnings: string[] = [];
    const puts: string[] = [];
    const cacheHost = {
      cache: {
        get: async () =>
          bytes === undefined ? undefined : { bytes, storedAt: new Date().toISOString() },
        put: async (key: string) => {
          puts.push(key);
          return { storedAt: new Date().toISOString() };
        },
        delete: async () => false,
        list: async () => [],
      },
      log: { debug() {}, info() {}, warn: (line: string) => warnings.push(line), error() {} },
    } as unknown as CacheHost;
    return { cacheHost, warnings, puts };
  }

  it('ignores an entry over 32 MiB, and stores none', async () => {
    const big = host(new Uint8Array(ENTRY_LIMIT_BYTES + 1));
    expect(await readCache(big.cacheHost, call, undefined, Date.now())).toBeUndefined();
    await writeCache(big.cacheHost, call, 1, {
      search: 'x'.repeat(ENTRY_LIMIT_BYTES),
      comments: {},
      parents: null,
    });
    expect(big.puts).toEqual([]);
    expect(big.warnings).toEqual([
      `jira.pull ignored a cache entry of ${ENTRY_LIMIT_BYTES + 1} bytes`,
      expect.stringContaining("over the host's limit"),
    ]);
  });

  it('ignores an entry that is not its own', async () => {
    const odd = host(new TextEncoder().encode('{"v":2}'));
    expect(await readCache(odd.cacheHost, call, undefined, Date.now())).toBeUndefined();
    expect(odd.warnings).toEqual(['jira.pull ignored a cache entry it did not write']);
  });
});
