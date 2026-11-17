import type { TestRecipeOptions } from '@tyto/plugin-api/testing';
import { afterEach, describe, expect, it } from 'vitest';

import { BUDGET_MILLISECONDS, refreshTable } from '../src/refresh.js';
import { jiraHost, response } from './host.js';
import {
  adf,
  fakeSite,
  issue,
  page,
  route,
  SITE,
  TOKEN,
  type FakeSite,
  type JiraCall,
  type Route,
} from './jira.js';

/**
 * `jira.refresh` through `testPlugin` and `runRecipe`: the committed bundle, handed the table
 * of the steps before it — an `input` table, and `recall` over a synthetic state store.
 */
type InputTable = NonNullable<TestRecipeOptions['input']>;
type RecipeState = NonNullable<TestRecipeOptions['state']>;

let open: FakeSite | undefined;
async function site(...args: Parameters<typeof fakeSite>): Promise<FakeSite> {
  open = await fakeSite(...args);
  return open;
}
afterEach(async () => {
  await open?.plugin.close();
  open = undefined;
});

const BULK = '/rest/api/3/issue/bulkfetch';
const SEARCH = '/rest/api/3/search/jql';

/** What the last cell of a recipe answered. */
async function run(jira: FakeSite, source: string, options: TestRecipeOptions = {}) {
  const ran = await jira.plugin.runRecipe(source, options);
  if (!ran.ok) throw new Error(ran.error.map((item) => item.message).join('\n'));
  const cell = ran.value.cells.at(-1);
  return {
    status: cell?.status,
    table: cell?.table,
    diagnostics: (cell?.diagnostics ?? []).map(({ code, message }) => ({ code, message })),
  };
}

/** A state store that holds `entries` and writes nothing. */
function memoryState(stores: Readonly<Record<string, readonly string[]>>): RecipeState {
  const entriesOf = (store: string) =>
    new Map(
      (stores[store] ?? []).map((key) => [
        key,
        { values: {}, storedAt: '2026-11-01T00:00:00.000Z' },
      ]),
    );
  return {
    read: async (store, keys) => ({
      ok: true,
      value: new Map([...entriesOf(store)].filter(([key]) => keys.includes(key))),
      diagnostics: [],
    }),
    entries: async (store) => ({ ok: true, value: entriesOf(store), diagnostics: [] }),
    write: async () => ({ ok: true, value: undefined, diagnostics: [] }),
  };
}

/** A table of the test's own: a `key` and a `note` column, and one row per key. */
function sheet(keys: readonly string[], extra: InputTable['columns'] = []): InputTable {
  return {
    columns: [
      { name: 'key', type: 'text', origin: 'sheet' },
      { name: 'note', type: 'text', origin: 'sheet' },
      ...extra,
    ],
    rows: keys.map((key) => ({
      key,
      values: { key, note: `note ${key}` },
      provenance: { source: 'sheet', id: key, fetchedAt: '2026-11-01T00:00:00.000Z' },
    })),
  };
}

type Issue = Readonly<Record<string, unknown>>;

/**
 * Answers `bulkfetch` from the issues it holds, by key; `moved` answers an old key as the issue
 * it became, and any other key comes back in `issueErrors`. Children are searched by
 * `parent in (...)`, and optionally an issue type, over `searched` when given: what Jira's
 * search index holds, which can lag behind the issues themselves.
 */
function jiraOf(
  issues: readonly Issue[],
  moved: Readonly<Record<string, Issue>> = {},
  searched?: readonly Issue[],
): Route {
  const byKey = new Map(issues.map((each) => [each['key'] as string, each]));
  return (call: JiraCall) => {
    if (call.method === 'POST' && call.path === BULK) {
      const asked = (call.body as { issueIdsOrKeys: string[] }).issueIdsOrKeys;
      const found = asked.map((key) => byKey.get(key) ?? moved[key]).filter((each) => !!each);
      const missing = asked.filter((key) => !byKey.has(key) && moved[key] === undefined);
      return response(200, {
        issues: found,
        issueErrors:
          missing.length === 0
            ? []
            : [{ issueIdsOrKeys: missing, errorMessages: ['Issue does not exist'] }],
      });
    }
    if (call.method === 'GET' && call.path.startsWith('/rest/api/3/issue/')) {
      const key = decodeURIComponent(call.path.slice('/rest/api/3/issue/'.length));
      const found = moved[key] ?? byKey.get(key);
      return found === undefined ? response(404, { errorMessages: ['no'] }) : response(200, found);
    }
    if (call.method === 'POST' && call.path === SEARCH) {
      const jql = (call.body as { jql: string }).jql;
      // The clause after the type is Jira's to read; the fake checks only parent and type.
      const asked =
        /^parent in \(([^)]*)\)(?: AND issuetype = "([^"]*)")?(?: AND \(.*\))? ORDER BY key ASC$/.exec(
          jql,
        );
      const parents = asked?.[1]?.split(', ') ?? [];
      const type = asked?.[2];
      return response(
        200,
        page(
          (searched ?? issues).filter((each) => {
            const fields = each['fields'] as {
              parent?: { key?: string } | null;
              issuetype?: { name?: string };
            };
            return (
              fields.parent?.key !== undefined &&
              parents.includes(fields.parent.key) &&
              (type === undefined || fields.issuetype?.name === type)
            );
          }),
        ),
      );
    }
    return undefined;
  };
}

function bulkCalls(jira: FakeSite): string[][] {
  return jira.calls
    .filter((call) => call.path === BULK)
    .map((call) => (call.body as { issueIdsOrKeys: string[] }).issueIdsOrKeys);
}

const FIXED = [
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
];

describe('jira.refresh after recall', () => {
  it('fills the recalled rows, and leaves the rows outside only= as they were', async () => {
    const jira = await site(
      [
        route('GET', '/rest/api/3/field', [
          { id: 'customfield_10016', name: 'Story Points', schema: { type: 'number' } },
        ]),
        jiraOf([issue(2, { customfield_10016: 3 }), issue(3, { status: { name: 'Done' } })]),
      ],
      { section: { fields: { story_points: 'customfield_10016' } } },
    );
    const answer = await run(jira, 'recall waiting mark=recalled\njira.refresh only=recalled', {
      input: sheet(['EX-1']),
      state: memoryState({ waiting: ['EX-1', 'EX-2', 'EX-3'] }),
    });
    expect(answer.diagnostics).toEqual([]);
    expect(answer.table?.columns.map((column) => `${column.name}:${column.type}`)).toEqual([
      'key:text',
      'note:text',
      'recalled:boolean',
      ...FIXED.slice(1),
      'story_points:number',
    ]);
    expect(answer.table?.rows.map((row) => row.key)).toEqual(['EX-1', 'EX-2', 'EX-3']);
    const [mine, second, third] = answer.table?.rows ?? [];
    expect(mine?.values).toMatchObject({ key: 'EX-1', note: 'note EX-1', url: null, status: null });
    expect(mine?.provenance.source).toBe('sheet');
    expect(second?.values).toMatchObject({
      key: 'EX-2',
      url: `${SITE}/browse/EX-2`,
      status: 'In Progress',
      summary: 'Issue 2',
      created: '2026-10-01T13:15:30.000Z',
      description_urls: ['https://docs.example.com/2'],
      story_points: 3,
      recalled: true,
    });
    expect(second?.provenance).toMatchObject({ source: 'jira.refresh', id: 'EX-2' });
    expect(third?.values['status']).toBe('Done');
    expect(jira.calls.filter((call) => call.path === BULK).map((call) => call.body)).toEqual([
      {
        issueIdsOrKeys: ['EX-2', 'EX-3'],
        fields: [
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
          'customfield_10016',
        ],
      },
    ]);
  });

  it('reads the key from by= and keeps it there', async () => {
    const jira = await site([jiraOf([issue(4)])]);
    const input: InputTable = {
      columns: [{ name: 'parent', type: 'text', origin: 'sheet' }],
      rows: [],
    };
    const answer = await run(jira, 'recall waiting by=parent\njira.refresh by=parent', {
      input,
      state: memoryState({ waiting: ['EX-4'] }),
    });
    expect(answer.diagnostics).toEqual([]);
    expect(answer.table?.rows[0]).toMatchObject({
      key: 'EX-4',
      values: { parent: 'EX-4', key: 'EX-4', summary: 'Issue 4' },
    });
  });
});

describe('jira.refresh rows', () => {
  it('asks bulkfetch 100 keys at a time', async () => {
    const keys = Array.from({ length: 250 }, (_, index) => `EX-${index + 1}`);
    const jira = await site([jiraOf(keys.map((_, index) => issue(index + 1)))]);
    const answer = await run(jira, 'jira.refresh', { input: sheet(keys) });
    expect(answer.diagnostics).toEqual([]);
    expect(bulkCalls(jira).map((asked) => asked.length)).toEqual([100, 100, 50]);
    expect(answer.table?.rows.every((row) => row.values['summary'] !== null)).toBe(true);
  });

  it('keeps a deleted issue as a row with its key and no Jira values', async () => {
    const jira = await site([jiraOf([issue(1)])]);
    // What an earlier refresh wrote: a summary that must not outlive the issue.
    const input = sheet(['EX-1', 'EX-9'], [{ name: 'summary', type: 'text', origin: 'jira' }]);
    const stale: InputTable = {
      ...input,
      rows: input.rows.map((row) => ({ ...row, values: { ...row.values, summary: 'old' } })),
    };
    const answer = await run(jira, 'jira.refresh by=key', { input: stale });
    expect(answer.diagnostics).toEqual([]);
    expect(answer.table?.rows[0]?.values['summary']).toBe('Issue 1');
    const gone = answer.table?.rows[1];
    expect(gone?.key).toBe('EX-9');
    expect(gone?.values).toMatchObject({
      key: 'EX-9',
      note: 'note EX-9',
      url: null,
      summary: null,
      labels: null,
    });
    expect(gone?.provenance.source).toBe('sheet');
    expect(jira.calls.filter((call) => call.method === 'GET')).toEqual([]);
  });

  it('follows a moved issue to its new key, and keeps the row key', async () => {
    const now = { ...issue(3), key: 'NEW-3' };
    const jira = await site([jiraOf([], { 'EX-7': now })]);
    const answer = await run(jira, 'jira.refresh', { input: sheet(['EX-7']) });
    expect(answer.diagnostics).toEqual([]);
    expect(answer.table?.rows[0]).toMatchObject({
      key: 'EX-7',
      values: { key: 'NEW-3', url: `${SITE}/browse/NEW-3` },
      provenance: { source: 'jira.refresh', id: 'NEW-3' },
    });
    expect(jira.calls.filter((call) => call.method === 'GET').map((call) => call.path)).toEqual([
      '/rest/api/3/issue/EX-7',
    ]);
  });

  it('adds the children with children=true, and updates a child that is already a row', async () => {
    const jira = await site([
      jiraOf([
        issue(1, { description: adf('epic', 'https://epic.example.com/') }),
        issue(10, { parent: { key: 'EX-1' }, summary: 'now' }),
        issue(11, { parent: { key: 'EX-1' } }),
      ]),
    ]);
    const input = sheet(['EX-10', 'EX-1'], [{ name: 'pick', type: 'boolean', origin: 'sheet' }]);
    const marked: InputTable = {
      ...input,
      rows: input.rows.map((row) => ({
        ...row,
        values: { ...row.values, pick: row.key === 'EX-1' },
      })),
    };
    const answer = await run(jira, 'jira.refresh only=pick children=true', { input: marked });
    expect(answer.diagnostics).toEqual([]);
    expect(answer.table?.rows.map((row) => [row.key, row.values['summary']])).toEqual([
      ['EX-10', 'now'],
      ['EX-1', 'Issue 1'],
      ['EX-11', 'Issue 11'],
    ]);
    const child = answer.table?.rows[2];
    expect(child?.values).toMatchObject({
      parent_key: 'EX-1',
      parent_description_urls: ['https://epic.example.com/'],
      note: null,
      pick: null,
    });
    expect(child?.provenance).toMatchObject({ source: 'jira.refresh', id: 'EX-11' });
    expect(bulkCalls(jira)).toEqual([['EX-1']]);
    expect(jira.calls.filter((call) => call.path === SEARCH).map((call) => call.body)).toEqual([
      expect.objectContaining({ jql: 'parent in (EX-1) ORDER BY key ASC' }),
    ]);
  });
});

describe('jira.refresh sisters=', () => {
  /** Under parent EX-1, two designs and a copy; under EX-2, one design and nothing else. */
  const family = (): Issue[] => [
    issue(1, { summary: 'Campaign' }),
    issue(10, { parent: { key: 'EX-1' }, issuetype: { name: 'DESIGN' } }),
    issue(11, { parent: { key: 'EX-1' }, issuetype: { name: 'DESIGN' } }),
    issue(12, {
      parent: { key: 'EX-1' },
      issuetype: { name: 'COPYWRITER' },
      description: adf('copy', 'https://docs.example.com/copy'),
    }),
    issue(2, { summary: 'Other campaign' }),
    issue(20, { parent: { key: 'EX-2' }, issuetype: { name: 'DESIGN' } }),
  ];

  it('adds the one copy sister of two designs once, and none to a design without one', async () => {
    const jira = await site([jiraOf(family())]);
    const answer = await run(jira, 'jira.refresh sisters=COPYWRITER', {
      input: sheet(['EX-10', 'EX-11', 'EX-20']),
    });
    expect(answer.diagnostics).toEqual([]);
    expect(
      answer.table?.rows.map((row) => [row.key, row.values['issuetype'], row.values['parent_key']]),
    ).toEqual([
      ['EX-10', 'DESIGN', 'EX-1'],
      ['EX-11', 'DESIGN', 'EX-1'],
      ['EX-20', 'DESIGN', 'EX-2'],
      ['EX-12', 'COPYWRITER', 'EX-1'],
    ]);
    expect(answer.table?.rows[3]?.values).toMatchObject({
      description_urls: ['https://docs.example.com/copy'],
      note: null,
    });
    expect(answer.table?.rows[3]?.provenance).toMatchObject({
      source: 'jira.refresh',
      id: 'EX-12',
    });
  });

  it('asks one search for every parent, with the type quoted', async () => {
    const jira = await site([jiraOf(family())]);
    await run(jira, 'jira.refresh sisters=COPYWRITER', {
      input: sheet(['EX-10', 'EX-11', 'EX-20']),
    });
    expect(jira.calls.filter((call) => call.path === SEARCH).map((call) => call.body)).toEqual([
      expect.objectContaining({
        jql: 'parent in (EX-1, EX-2) AND issuetype = "COPYWRITER" ORDER BY key ASC',
      }),
    ]);
  });

  it('adds sisters-jql= to the search in parentheses', async () => {
    const jira = await site([jiraOf(family())]);
    const answer = await run(
      jira,
      'jira.refresh sisters=COPYWRITER sisters-jql="status != Cancelled"',
      { input: sheet(['EX-10']) },
    );
    expect(answer.diagnostics).toEqual([]);
    expect(jira.calls.filter((call) => call.path === SEARCH).map((call) => call.body)).toEqual([
      expect.objectContaining({
        jql:
          'parent in (EX-1) AND issuetype = "COPYWRITER" AND (status != Cancelled) ' +
          'ORDER BY key ASC',
      }),
    ]);
  });

  it('never brings back the own issue of a row as its sister, and keeps what bulkfetch read', async () => {
    // The search index still holds an older summary of EX-10, which has the type asked for.
    const stale = family().map((each) =>
      each['key'] === 'EX-10'
        ? { ...each, fields: { ...(each['fields'] as object), summary: 'indexed' } }
        : each,
    );
    const jira = await site([jiraOf(family(), {}, stale)]);
    const answer = await run(jira, 'jira.refresh sisters=DESIGN', { input: sheet(['EX-10']) });
    expect(answer.diagnostics).toEqual([]);
    expect(answer.table?.rows.map((row) => [row.key, row.values['summary']])).toEqual([
      ['EX-10', 'Issue 10'],
      ['EX-11', 'Issue 11'],
    ]);
  });

  it('updates a sister that is already a row in place', async () => {
    const jira = await site([jiraOf(family())]);
    const input = sheet(['EX-10', 'EX-12'], [{ name: 'pick', type: 'boolean', origin: 'sheet' }]);
    const marked: InputTable = {
      ...input,
      rows: input.rows.map((row) => ({
        ...row,
        values: { ...row.values, pick: row.key === 'EX-10' },
      })),
    };
    const answer = await run(jira, 'jira.refresh only=pick sisters=COPYWRITER', { input: marked });
    expect(answer.diagnostics).toEqual([]);
    expect(answer.table?.rows.map((row) => [row.key, row.values['issuetype']])).toEqual([
      ['EX-10', 'DESIGN'],
      ['EX-12', 'COPYWRITER'],
    ]);
  });

  it('searches nothing when no refreshed issue has a parent', async () => {
    const jira = await site([jiraOf(family())]);
    const answer = await run(jira, 'jira.refresh sisters=COPYWRITER', { input: sheet(['EX-1']) });
    expect(answer.diagnostics).toEqual([]);
    expect(answer.table?.rows.map((row) => row.key)).toEqual(['EX-1']);
    expect(jira.calls.filter((call) => call.path === SEARCH)).toEqual([]);
  });

  it('refuses an empty sisters=, and sisters-jql= without it', async () => {
    const jira = await site([jiraOf(family())]);
    const empty = await run(jira, 'jira.refresh sisters=""', { input: sheet(['EX-10']) });
    expect(empty.diagnostics.map((each) => each.code)).toEqual(['E_RECIPE_ARGUMENTS']);
    expect(empty.diagnostics[0]?.message).toContain('sisters= is empty');
    const alone = await run(jira, 'jira.refresh sisters-jql="status = Done"', {
      input: sheet(['EX-10']),
    });
    expect(alone.diagnostics[0]?.message).toContain('name the issue type with sisters= too');
    expect(jira.calls).toEqual([]);
  });
});

describe('jira.refresh prefix= and row keys', () => {
  /** A sheet whose rows have keys of their own, a ticket column, and a status of the sheet's. */
  const tracked: InputTable = {
    columns: [
      { name: 'ticket', type: 'text', origin: 'sheet' },
      { name: 'status', type: 'text', origin: 'sheet' },
    ],
    rows: [
      {
        key: 'row-7',
        values: { ticket: 'EX-1', status: 'SHEET DONE' },
        provenance: { source: 'sheet', id: 'row-7', fetchedAt: '2026-11-01T00:00:00.000Z' },
      },
    ],
  };

  it('writes its columns under the prefix, leaving a column of the same name as it was', async () => {
    const jira = await site([jiraOf([issue(1)])]);
    const answer = await run(jira, 'jira.refresh by=ticket prefix=jira_', { input: tracked });
    expect(answer.diagnostics).toEqual([]);
    expect(answer.table?.columns.map((column) => column.name)).toEqual([
      'ticket',
      'status',
      ...FIXED.map((column) => `jira_${column.split(':')[0] ?? ''}`),
    ]);
    expect(answer.table?.rows).toMatchObject([
      {
        key: 'row-7',
        values: {
          ticket: 'EX-1',
          status: 'SHEET DONE',
          jira_key: 'EX-1',
          jira_status: 'In Progress',
          jira_summary: 'Issue 1',
        },
      },
    ]);
  });

  it('keeps each row its key, and without prefix= overwrites the same-named column', async () => {
    const jira = await site([jiraOf([issue(1)])]);
    const answer = await run(jira, 'jira.refresh by=ticket', { input: tracked });
    expect(answer.table?.rows).toMatchObject([
      { key: 'row-7', values: { ticket: 'EX-1', status: 'In Progress' } },
    ]);
  });

  it('refuses a prefix that is not the start of a column name', async () => {
    const jira = await site([]);
    const answer = await run(jira, 'jira.refresh prefix="jira status"', { input: tracked });
    expect(answer.diagnostics).toEqual([
      {
        code: 'E_RECIPE_ARGUMENTS',
        message:
          "'jira.refresh' prefix= is 'jira status'; a prefix is letters, digits and " +
          'underscores, a letter first, such as jira_.',
      },
    ]);
    expect(jira.calls).toEqual([]);
  });
});

describe('jira.refresh refusals', () => {
  it('refuses 1,001 keys before any request', async () => {
    const keys = Array.from({ length: 1001 }, (_, index) => `EX-${index + 1}`);
    const jira = await site([]);
    const answer = await run(jira, 'jira.refresh', { input: sheet(keys) });
    expect(answer.table).toBeUndefined();
    expect(answer.diagnostics).toEqual([
      {
        code: 'E_RECIPE_VERB',
        message:
          "'jira.refresh' would refresh 1,001 issues, more than the 1,000 one call takes; narrow it with only=.",
      },
    ]);
    expect(jira.calls).toEqual([]);
  });

  it('refuses more than 5,000 children, never a partial table', async () => {
    const children = Array.from({ length: 5001 }, (_, index) =>
      issue(index + 2, { parent: { key: 'EX-1' } }),
    );
    const jira = await site([jiraOf([issue(1), ...children])]);
    const answer = await run(jira, 'jira.refresh children=true', { input: sheet(['EX-1']) });
    expect(answer.table).toBeUndefined();
    expect(answer.diagnostics).toEqual([
      {
        code: 'E_RECIPE_VERB',
        message: "'jira.refresh' found more than 5,000 children of 1 issue; narrow it with only=.",
      },
    ]);
  });

  it('refuses a column of the same name and another type', async () => {
    const jira = await site([jiraOf([issue(1)])]);
    const answer = await run(jira, 'jira.refresh', {
      input: sheet(['EX-1'], [{ name: 'status', type: 'number', origin: 'sheet' }]),
    });
    expect(answer.diagnostics).toEqual([
      {
        code: 'E_RECIPE_ARGUMENTS',
        message:
          "'jira.refresh' would write text column status, and the table's status is number; rename it before this step.",
      },
    ]);
    expect(bulkCalls(jira)).toEqual([]);
  });

  it('refuses by= naming a column it writes, and only= naming one that is not boolean', async () => {
    const jira = await site([]);
    const by = await run(jira, 'jira.refresh by=summary', {
      input: sheet(['EX-1'], [{ name: 'summary', type: 'text', origin: 'sheet' }]),
    });
    expect(by.diagnostics.map((item) => item.code)).toEqual(['E_RECIPE_ARGUMENTS']);
    expect(by.diagnostics[0]?.message).toContain('by= names summary, a column this verb writes');
    const only = await run(jira, 'jira.refresh only=note', { input: sheet(['EX-1']) });
    expect(only.diagnostics[0]?.message).toContain('only= names note, a text column');
    expect(jira.calls).toEqual([]);
  });

  it('fails the whole refresh on a 401', async () => {
    const jira = await site([route('POST', BULK, '', 401)]);
    const answer = await run(jira, 'jira.refresh', { input: sheet(['EX-1']) });
    expect(answer.table).toBeUndefined();
    expect(answer.diagnostics).toEqual([
      {
        code: 'E_RECIPE_VERB',
        message: expect.stringMatching(
          /^'jira\.refresh' failed: E_JIRA_AUTH: Jira refused the API token for person@example\.com/,
        ),
      },
    ]);
  });

  it('retries a 429 and goes on', async () => {
    let first = true;
    const jira = await site([
      (call) => {
        if (call.path !== BULK || !first) return undefined;
        first = false;
        return response(429, '', { 'Retry-After': '0' });
      },
      jiraOf([issue(1)]),
    ]);
    const answer = await run(jira, 'jira.refresh', { input: sheet(['EX-1']) });
    expect(answer.table?.rows[0]?.values['summary']).toBe('Issue 1');
    expect(bulkCalls(jira)).toHaveLength(2);
  });

  it('never repeats the token in a message', async () => {
    const jira = await site([
      route('POST', BULK, { errorMessages: [`token ${TOKEN} refused`] }, 400),
    ]);
    const answer = await run(jira, 'jira.refresh', { input: sheet(['EX-1']) });
    const text = JSON.stringify(answer.diagnostics) + jira.plugin.log.join('\n');
    expect(text).toContain('[redacted]');
    expect(text).not.toContain(TOKEN);
  });
});

describe('the time budget', () => {
  it('stops at 25 s with the narrowing message, never a partial table', async () => {
    let now = 0;
    const { host, requests } = jiraHost({
      settings: { baseUrl: SITE, email: null },
      secrets: { 'api-token': TOKEN, email: 'person@example.com' },
      async fetch(_url, init) {
        // Every bulkfetch takes ten seconds of the clock the refresh reads.
        now += 10_000;
        const asked = (JSON.parse(String(init.body)) as { issueIdsOrKeys: string[] })
          .issueIdsOrKeys;
        return response(200, { issues: asked.map((key) => issue(Number(key.slice(3)))) });
      },
    });
    const keys = Array.from({ length: 400 }, (_, index) => `EX-${index + 1}`);
    const answer = await refreshTable(
      host,
      { arguments: {}, table: sheet(keys) },
      { now: () => now },
    );
    expect(answer).toEqual({
      ok: false,
      error: [
        {
          severity: 'error',
          code: 'E_RECIPE_VERB',
          message: `'jira.refresh' did not finish 400 issues within ${BUDGET_MILLISECONDS / 1000} s; narrow it with only=.`,
        },
      ],
    });
    expect(requests).toHaveLength(3);
  });
});
