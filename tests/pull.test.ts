import { afterEach, describe, expect, it } from 'vitest';

import { decodeCursor, encodeCursor, fingerprint, MAX_CURSOR_LENGTH } from '../src/cursor.js';
import { response } from './host.js';
import {
  adf,
  EMAIL,
  fakeSite,
  issue,
  page,
  pull,
  route,
  searchPages,
  SITE,
  TOKEN,
  type FakeSite,
} from './jira.js';

/**
 * `jira.pull` through `testPlugin` and `runRecipe`, over a synthetic site: the committed bundle
 * in its own isolated host, the host's own paging loop (`pagedSource`) between the pages, and
 * the manifest's permissions in front of every request.
 */
let open: FakeSite | undefined;
async function site(...args: Parameters<typeof fakeSite>): Promise<FakeSite> {
  open = await fakeSite(...args);
  return open;
}
afterEach(async () => {
  await open?.plugin.close();
  open = undefined;
});

const JQL = 'jira.pull jql="project = EX"';

describe('jira.pull by JQL', () => {
  it('answers three pages as one table with fifteen columns and a provenance per row', async () => {
    const jira = await site([
      searchPages({
        '': page([issue(1), issue(2)], 'token-2'),
        'token-2': page([issue(3), issue(4)], 'token-3', false),
        'token-3': page([issue(5)]),
      }),
    ]);
    const answer = await pull(jira, JQL);
    expect(answer.diagnostics).toEqual([]);
    expect(answer.table?.columns.map((column) => `${column.name}:${column.type}`)).toEqual([
      'key:text',
      'url:link',
      'project:text',
      'issuetype:text',
      'status:text',
      'status_category:text',
      'summary:text',
      'parent_key:text',
      'assignee:text',
      'labels:list',
      'created:datetime',
      'updated:datetime',
      'description_urls:list',
      'comment_urls:list',
      'parent_description_urls:list',
    ]);
    expect(answer.table?.columns.every((column) => column.origin === 'jira')).toBe(true);
    expect(answer.table?.rows.map((row) => row.key)).toEqual([
      'EX-1',
      'EX-2',
      'EX-3',
      'EX-4',
      'EX-5',
    ]);
    const first = answer.table?.rows[0];
    expect(first?.values).toEqual({
      key: 'EX-1',
      url: `${SITE}/browse/EX-1`,
      project: 'EX',
      issuetype: 'Task',
      status: 'In Progress',
      status_category: 'In Progress',
      summary: 'Issue 1',
      parent_key: null,
      assignee: 'A Person',
      labels: ['one', 'two'],
      created: '2026-10-01T13:15:30.000Z',
      updated: '2026-10-02T09:00:00.000Z',
      description_urls: ['https://docs.example.com/1'],
      comment_urls: [],
      parent_description_urls: [],
    });
    expect(first?.provenance).toMatchObject({ source: 'jira', id: '10001' });
    expect(Number.isNaN(Date.parse(first?.provenance.fetchedAt ?? ''))).toBe(false);

    const searches = jira.calls.filter((call) => call.path === '/rest/api/3/search/jql');
    expect(searches.map((call) => call.body)).toEqual([
      expect.objectContaining({ jql: 'project = EX', maxResults: 50 }),
      expect.objectContaining({ jql: 'project = EX', nextPageToken: 'token-2' }),
      expect.objectContaining({ jql: 'project = EX', nextPageToken: 'token-3' }),
    ]);
    expect((searches[0]?.body as { fields: string[] }).fields).toEqual([
      'summary',
      'project',
      'issuetype',
      'status',
      'parent',
      'assignee',
      'labels',
      'created',
      'updated',
      'description',
      'comment',
    ]);
  });

  it('is cut short, never a short table, when Jira says more with no token', async () => {
    const jira = await site([searchPages({ '': page([issue(1)], undefined, false) })]);
    const answer = await pull(jira, JQL);
    expect(answer.table).toBeUndefined();
    expect(answer.diagnostics).toEqual([
      expect.objectContaining({
        code: 'E_RECIPE_SOURCE',
        message: expect.stringContaining('cut page 1 short'),
      }),
    ]);
  });

  it('is cut short when the rows would pass max=', async () => {
    const pages = {
      '': page([issue(1), issue(2)], 'token-2'),
      'token-2': page([issue(3), issue(4)]),
    };
    const over = await pull(await site([searchPages(pages)]), `${JQL} max=3`);
    expect(over.diagnostics.map((item) => item.code)).toEqual(['E_RECIPE_SOURCE']);
    expect(over.diagnostics[0]?.message).toContain('cut page 2 short');
    await open?.plugin.close();

    const atMaxWithMore = await pull(await site([searchPages(pages)]), `${JQL} max=2`);
    expect(atMaxWithMore.diagnostics[0]?.message).toContain('cut page 1 short');
    await open?.plugin.close();

    const exact = await pull(await site([searchPages(pages)]), `${JQL} max=4`);
    expect(exact.table?.rows).toHaveLength(4);
  });

  it('is refused by the host when Jira hands back the token it was given', async () => {
    const jira = await site([
      searchPages({ '': page([issue(1)], 'token-2'), 'token-2': page([issue(2)], 'token-2') }),
    ]);
    const answer = await pull(jira, JQL);
    expect(answer.diagnostics).toEqual([
      expect.objectContaining({
        code: 'E_RECIPE_SOURCE',
        message: expect.stringContaining('a second time'),
      }),
    ]);
  });

  it('is refused by the host when two pages hold one key', async () => {
    const jira = await site([
      searchPages({ '': page([issue(1)], 'token-2'), 'token-2': page([issue(1)]) }),
    ]);
    const answer = await pull(jira, JQL);
    expect(answer.diagnostics).toEqual([
      expect.objectContaining({
        code: 'E_RECIPE_SOURCE',
        message: expect.stringContaining("'EX-1' twice"),
      }),
    ]);
  });

  it('fails the whole pull on a 401 on page 2', async () => {
    const jira = await site([
      searchPages({ '': page([issue(1)], 'token-2'), 'token-2': response(401, '') }),
    ]);
    const answer = await pull(jira, JQL);
    expect(answer.status).toBe('failed');
    expect(answer.table).toBeUndefined();
    expect(answer.diagnostics).toEqual([
      {
        code: 'E_RECIPE_VERB',
        message: expect.stringMatching(
          /^'jira\.pull' failed: E_JIRA_AUTH: Jira refused the API token for person@example\.com/,
        ),
      },
    ]);
  });

  it('retries a 429 and goes on', async () => {
    let first = true;
    const jira = await site([
      (call) => {
        if (call.path !== '/rest/api/3/search/jql' || !first) return undefined;
        first = false;
        return response(429, '', { 'Retry-After': '0' });
      },
      searchPages({ '': page([issue(1)]) }),
    ]);
    const answer = await pull(jira, JQL);
    expect(answer.table?.rows).toHaveLength(1);
    expect(jira.calls.filter((call) => call.path === '/rest/api/3/search/jql')).toHaveLength(2);
  });

  it("quotes Jira's words for an unbounded JQL", async () => {
    const said =
      'Unbounded JQL queries are not allowed here. Please add a search restriction to your query.';
    const jira = await site([searchPages({ '': response(400, { errorMessages: [said] }) })]);
    const answer = await pull(jira, 'jira.pull jql="order by created"');
    expect(answer.diagnostics).toEqual([
      {
        code: 'E_RECIPE_VERB',
        message: `'jira.pull' failed: E_JIRA_HTTP: POST /rest/api/3/search/jql answered 400. Jira said: ${said}`,
      },
    ]);
  });

  it('answers a search that is not the promised shape as E_JIRA_RESPONSE', async () => {
    const jira = await site([searchPages({ '': { values: [] } })]);
    const answer = await pull(jira, JQL);
    expect(answer.diagnostics[0]?.message).toContain(
      "'jira.pull' failed: E_JIRA_RESPONSE: POST /rest/api/3/search/jql answered no issues list",
    );
  });

  it('never repeats the token in a message', async () => {
    const echoed = `token ${TOKEN} refused`;
    for (const status of [400, 403, 500]) {
      const jira = await site([searchPages({ '': response(status, { errorMessages: [echoed] }) })]);
      const answer = await pull(jira, JQL);
      const text = JSON.stringify(answer.diagnostics) + jira.plugin.log.join('\n');
      expect(text).toContain('[redacted]');
      expect(text).not.toContain(TOKEN);
      await jira.plugin.close();
      open = undefined;
    }
  });
});

describe('jira.pull selectors', () => {
  it('pulls a board by its saved filter, without the Kanban sub-query', async () => {
    const jira = await site([
      route('GET', '/rest/agile/1.0/board/12/configuration', {
        id: 12,
        filter: { id: '10001' },
        subQuery: { query: 'fixVersion in unreleasedVersions() OR fixVersion is EMPTY' },
      }),
      route('GET', '/rest/api/3/filter/10001', {
        id: '10001',
        jql: 'project = EX ORDER BY Rank ASC',
      }),
      searchPages({ '': page([issue(1)]) }),
    ]);
    const answer = await pull(jira, 'jira.pull board=12');
    expect(answer.table?.rows).toHaveLength(1);
    expect(jira.calls.at(-1)?.body).toMatchObject({ jql: 'project = EX ORDER BY Rank ASC' });
  });

  it('says a board without a filter cannot be pulled', async () => {
    const jira = await site([route('GET', '/rest/agile/1.0/board/7/configuration', { id: 7 })]);
    const answer = await pull(jira, 'jira.pull board=7');
    expect(answer.diagnostics).toEqual([
      {
        code: 'E_RECIPE_VERB',
        message: expect.stringMatching(
          /^'jira\.pull' failed: E_JIRA_CONFIG: board 7 has no saved filter/,
        ),
      },
    ]);
  });

  it('pulls keys and a parent as JQL', async () => {
    const jira = await site([searchPages({ '': page([issue(1)]) })]);
    await pull(jira, 'jira.pull keys="EX-1, EX_2-20,EX-1"');
    await pull(jira, 'jira.pull parent=EX-9');
    expect(jira.calls.map((call) => (call.body as { jql: string }).jql)).toEqual([
      'key in (EX-1, EX_2-20)',
      'parent = EX-9',
    ]);
  });

  it.each([
    ['jira.pull keys="EX-1,ex-2"', "keys= holds 'ex-2'"],
    ['jira.pull keys="EX-1,,EX-2"', "keys= holds ''"],
    ['jira.pull parent="EX-1,EX-2"', "parent= holds 'EX-1,EX-2'"],
    ['jira.pull', 'needs one of jql=, board=, keys= or parent=, and was given none'],
    ['jira.pull jql="project = EX" board=3', 'was given jql= and board='],
    ['jira.pull board=0', "board= must be a board's number"],
    ['jira.pull jql="project = EX" max=100001', 'max= must be a whole number from 1 to 100000'],
  ])('refuses %s without a request', async (step, problem) => {
    const jira = await site([]);
    const answer = await pull(jira, step);
    expect(answer.diagnostics).toEqual([
      { code: 'E_RECIPE_ARGUMENTS', message: expect.stringContaining(problem) },
    ]);
    expect(jira.calls).toEqual([]);
  });
});

describe('jira.pull rows', () => {
  it('reads every comment, in order, when the search embedded only some', async () => {
    const comment = (n: number) => ({
      id: String(n),
      body: adf(`c${n}`, `https://c.example.com/${n}`),
    });
    const jira = await site([
      searchPages({
        '': page([
          issue(1, { comment: { comments: [comment(1)], total: 3, maxResults: 1, startAt: 0 } }),
        ]),
      }),
      (call) =>
        call.path === '/rest/api/3/issue/EX-1/comment'
          ? response(200, {
              comments: call.query['startAt'] === '0' ? [comment(1), comment(2)] : [comment(3)],
              total: 3,
            })
          : undefined,
    ]);
    const answer = await pull(jira, JQL);
    expect(answer.table?.rows[0]?.values['comment_urls']).toEqual([
      'https://c.example.com/1',
      'https://c.example.com/2',
      'https://c.example.com/3',
    ]);
    expect(
      jira.calls.filter((call) => call.path.endsWith('/comment')).map((call) => call.query),
    ).toEqual([
      { orderBy: 'created', startAt: '0', maxResults: '100' },
      { orderBy: 'created', startAt: '2', maxResults: '100' },
    ]);
  });

  it('reads parents from the page, then one bulkfetch, and leaves a missing one empty', async () => {
    const jira = await site([
      searchPages({
        '': page([
          issue(1, { description: adf('epic', 'https://epic.example.com/') }),
          issue(2, { parent: { key: 'EX-1' } }),
          issue(3, { parent: { key: 'EX-90' } }),
          issue(4, { parent: { key: 'EX-91' } }),
        ]),
      }),
      route('POST', '/rest/api/3/issue/bulkfetch', {
        issues: [
          {
            id: '10091',
            key: 'EX-91',
            fields: { description: adf('far', 'https://far.example.com/') },
          },
        ],
        issueErrors: [{ issueIdsOrKeys: ['EX-90'], errorMessages: ['Issue does not exist'] }],
      }),
    ]);
    const answer = await pull(jira, JQL);
    expect(
      answer.table?.rows.map((row) => [
        row.values['parent_key'],
        row.values['parent_description_urls'],
      ]),
    ).toEqual([
      [null, []],
      ['EX-1', ['https://epic.example.com/']],
      ['EX-90', []],
      ['EX-91', ['https://far.example.com/']],
    ]);
    const bulk = jira.calls.filter((call) => call.path === '/rest/api/3/issue/bulkfetch');
    expect(bulk.map((call) => call.body)).toEqual([
      { issueIdsOrKeys: ['EX-90', 'EX-91'], fields: ['description'] },
    ]);
  });

  it('answers a date Jira did not write as a date as E_JIRA_RESPONSE', async () => {
    const jira = await site([searchPages({ '': page([issue(1, { created: 'yesterday' })]) })]);
    const answer = await pull(jira, JQL);
    expect(answer.diagnostics[0]?.message).toContain(
      `E_JIRA_RESPONSE: EX-1's created is "yesterday"`,
    );
  });
});

describe('the cursor', () => {
  it('refuses a page whose section names another site than the first page did', async () => {
    let reads = 0;
    const section = {
      get baseUrl() {
        reads += 1;
        return reads === 1 ? SITE : 'https://other.atlassian.net';
      },
    };
    const jira = await site(
      [searchPages({ '': page([issue(1)], 'token-2'), 'token-2': page([issue(2)]) })],
      { section },
    );
    const answer = await pull(jira, JQL);
    expect(answer.diagnostics).toEqual([
      {
        code: 'E_RECIPE_VERB',
        message:
          "'jira.pull' failed: E_JIRA_CONFIG: the jira section changed during the pull; run again.",
      },
    ]);
  });

  it('is refused when undecodable or too long, before any request', async () => {
    const jira = await site([]);
    const verb = jira.plugin.host.registry.recipeVerbs()[0];
    // Well formed but over the length: only the length check refuses it.
    const long = encodeCursor({
      v: 1,
      t: 'a'.repeat(3100),
      n: 0,
      p: 2,
      f: '',
      m: {},
      g: 0,
      c: false,
    });
    expect(long.length).toBeGreaterThan(MAX_CURSOR_LENGTH);
    const refusals: [string, string][] = [
      ['%%%', 'not base64url'],
      [long, 'characters long'],
      [encodeCursor({ v: 1 } as never), 'not one this plugin writes'],
    ];
    for (const [cursor, why] of refusals) {
      const answer = await verb?.page?.({ arguments: { jql: 'project = EX' }, cursor });
      expect(answer?.ok ? undefined : answer?.error[0]).toMatchObject({
        code: 'E_RECIPE_VERB',
        message: expect.stringContaining(why),
      });
    }
    expect(jira.calls).toEqual([]);
  });

  it('round-trips, and fingerprints with FNV-1a 64', () => {
    const cursor = {
      v: 1,
      t: 'tökén/+=',
      n: 50,
      p: 2,
      f: fingerprint('x'),
      m: {},
      g: 0,
      c: false,
    } as const;
    const encoded = encodeCursor(cursor);
    expect(encoded).toMatch(/^[A-Za-z0-9_-]+$/);
    expect(decodeCursor(encoded)).toEqual(cursor);
    expect(fingerprint('')).toBe('cbf29ce484222325');
    expect(fingerprint('a')).toBe('af63dc4c8601ec8c');
  });

  it('carries no secret', async () => {
    const jira = await site([
      searchPages({ '': page([issue(1)], 'token-2'), 'token-2': page([issue(2)]) }),
    ]);
    const verb = jira.plugin.host.registry.recipeVerbs()[0];
    const answer = await verb?.page?.({ arguments: { jql: 'project = EX' } });
    const cursor = answer?.ok ? answer.value.cursor : undefined;
    const decoded = JSON.stringify(decodeCursor(cursor ?? ''));
    expect(decoded).toContain('token-2');
    expect(decoded).not.toContain(TOKEN);
    expect(decoded).not.toContain(EMAIL);
  });
});
