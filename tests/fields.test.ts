import { afterEach, describe, expect, it } from 'vitest';

import { decodeCursor, encodeCursor } from '../src/cursor.js';

import {
  adf,
  fakeSite,
  issue,
  page,
  pull,
  pullVerbOf,
  route,
  searchPages,
  type FakeSite,
} from './jira.js';

/**
 * The `fields:` section: Jira fields mapped to columns after the fifteen fixed ones, typed by
 * the site's field catalogue. Synthetic ids throughout; no real site's fields.
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

/** A catalogue as `GET /rest/api/3/field` answers it. */
const CATALOGUE = [
  { id: 'summary', name: 'Summary', custom: false, schema: { type: 'string', system: 'summary' } },
  { id: 'customfield_10016', name: 'Story Points', custom: true, schema: { type: 'number' } },
  { id: 'customfield_10020', name: 'Team', custom: true, schema: { type: 'option' } },
  { id: 'customfield_10030', name: 'Due On', custom: true, schema: { type: 'date' } },
  { id: 'customfield_10031', name: 'Shipped At', custom: true, schema: { type: 'datetime' } },
  {
    id: 'customfield_10040',
    name: 'Channels',
    custom: true,
    schema: { type: 'array', items: 'option' },
  },
  { id: 'customfield_10050', name: 'Reviewer', custom: true, schema: { type: 'user' } },
  { id: 'customfield_10060', name: 'Notes', custom: true, schema: { type: 'string' } },
  { id: 'customfield_10070', name: 'Story Points', custom: true, schema: { type: 'number' } },
];
const catalogue = route('GET', '/rest/api/3/field', CATALOGUE);

const MAPPED = {
  fields: {
    points: 'customfield_10016',
    team: 'customfield_10020',
    due_on: 'customfield_10030',
    shipped_at: 'customfield_10031',
    channels: 'customfield_10040',
    reviewer: 'customfield_10050',
    notes: 'customfield_10060',
  },
};

function mappedIssue(n: number) {
  return issue(n, {
    customfield_10016: n * 2,
    customfield_10020: { value: 'Blue', id: '1' },
    customfield_10030: '2026-11-01',
    customfield_10031: '2026-11-01T09:00:00.000-0300',
    customfield_10040: [{ value: 'Web' }, { value: 'Mail' }],
    customfield_10050: { displayName: 'B Person', accountId: 'invented-1' },
    customfield_10060: adf('First line'),
  });
}

describe('the fields: section', () => {
  it('answers mapped columns after the fixed ones, typed by the catalogue read once', async () => {
    const jira = await site(
      [
        catalogue,
        searchPages({
          '': page([mappedIssue(1)], 'token-2'),
          'token-2': page([issue(2, { customfield_10016: null })]),
        }),
      ],
      { section: MAPPED },
    );
    const answer = await pull(jira, JQL);
    expect(answer.diagnostics).toEqual([]);
    expect(
      answer.table?.columns.slice(15).map((column) => `${column.name}:${column.type}`),
    ).toEqual([
      'points:number',
      'team:text',
      'due_on:date',
      'shipped_at:datetime',
      'channels:list',
      'reviewer:text',
      'notes:text',
    ]);
    expect(answer.table?.columns.length).toBe(22);
    expect(answer.table?.rows[0]?.values).toMatchObject({
      key: 'EX-1',
      points: 2,
      team: 'Blue',
      due_on: '2026-11-01',
      shipped_at: '2026-11-01T12:00:00.000Z',
      channels: ['Web', 'Mail'],
      reviewer: 'B Person',
      notes: 'First line',
    });
    expect(answer.table?.rows[1]?.values).toMatchObject({
      points: null,
      team: null,
      channels: [],
    });
    expect(jira.calls.filter((call) => call.path === '/rest/api/3/field')).toHaveLength(1);
    const searches = jira.calls.filter((call) => call.path === '/rest/api/3/search/jql');
    expect((searches[0]?.body as { fields: string[] }).fields.slice(11)).toEqual(
      Object.values(MAPPED.fields),
    );
  });

  it('reads no catalogue when the section maps nothing', async () => {
    const jira = await site([searchPages({ '': page([issue(1)]) })], {
      section: { fields: {} },
    });
    const answer = await pull(jira, JQL);
    expect(answer.table?.columns).toHaveLength(15);
    expect(jira.calls.map((call) => call.path)).toEqual(['/rest/api/3/search/jql']);
  });

  it('refuses an id the site does not have, before any search', async () => {
    const jira = await site([catalogue], {
      section: { fields: { points: 'customfield_99999' } },
    });
    const answer = await pull(jira, JQL);
    expect(answer.diagnostics).toEqual([
      {
        code: 'E_RECIPE_VERB',
        message:
          "'jira.pull' failed: E_JIRA_CONFIG: fields maps points to 'customfield_99999', and " +
          'this site has no field with that id.',
      },
    ]);
    expect(jira.calls.map((call) => call.path)).toEqual(['/rest/api/3/field']);
  });

  it("names the id when a field's name was written", async () => {
    const jira = await site([catalogue], { section: { fields: { points: 'story points' } } });
    const answer = await pull(jira, JQL);
    expect(answer.diagnostics[0]?.message).toBe(
      "'jira.pull' failed: E_JIRA_CONFIG: fields maps points to 'story points', which is a " +
        "field's name, not its id; write customfield_10016 or customfield_10070.",
    );
  });

  it('refuses a column named like a fixed one, before any request', async () => {
    const jira = await site([], { section: { fields: { summary: 'customfield_10016' } } });
    const answer = await pull(jira, JQL);
    expect(answer.diagnostics).toEqual([
      {
        code: 'E_RECIPE_VERB',
        message:
          "'jira.pull' failed: E_JIRA_CONFIG: fields names a column 'summary', which every " +
          'pull already answers; choose another name.',
      },
    ]);
    expect(jira.calls).toEqual([]);
  });

  it('refuses a column name that is not lower case, and a value that is not an id', async () => {
    const named = await site([], { section: { fields: { 'Story Points': 'customfield_1' } } });
    expect((await pull(named, JQL)).diagnostics[0]?.message).toContain(
      "fields names a column 'Story Points'; a column name is lower case letters",
    );
    await named.plugin.close();
    const valued = await site([], { section: { fields: { points: 16 } } });
    expect((await pull(valued, JQL)).diagnostics[0]?.message).toContain(
      'fields maps points to 16, which is not a field id',
    );
    expect(valued.calls).toEqual([]);
  });

  it('answers a value its type does not hold as E_JIRA_RESPONSE', async () => {
    const jira = await site(
      [catalogue, searchPages({ '': page([issue(1, { customfield_10016: 'many' })]) })],
      { section: { fields: { points: 'customfield_10016' } } },
    );
    const answer = await pull(jira, JQL);
    expect(answer.diagnostics[0]?.message).toBe(
      "'jira.pull' failed: E_JIRA_RESPONSE: EX-1's points is \"many\", which is not a number.",
    );
  });

  it('refuses a page whose section was edited after the first page', async () => {
    let reads = 0;
    const section = {
      get fields() {
        reads += 1;
        return reads === 1 ? { points: 'customfield_10016' } : { points: 'customfield_10070' };
      },
    };
    const jira = await site(
      [catalogue, searchPages({ '': page([issue(1)], 'token-2'), 'token-2': page([issue(2)]) })],
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
    expect(reads).toBe(2);
  });

  it('refuses a page whose mapped column was renamed, though the ids stayed', async () => {
    const jira = await site([
      catalogue,
      searchPages({ '': page([issue(1)], 'token-2'), 'token-2': page([issue(2)]) }),
    ]);
    const pageOf = pullVerbOf(jira);
    const first = await pageOf({
      arguments: { jql: 'project = EX' },
      section: { fields: { points: 'customfield_10016' } },
    });
    if (!first.ok || first.value.cursor === undefined) throw new Error('no second page');
    const second = await pageOf({
      arguments: { jql: 'project = EX' },
      section: { fields: { estimate: 'customfield_10016' } },
      cursor: first.value.cursor,
    });
    expect(second.ok ? [] : second.error.map((item) => item.message)).toEqual([
      "'jira.pull' failed: E_JIRA_CONFIG: the jira section changed during the pull; run again.",
    ]);
  });
});

describe('the cursor of a mapped pull', () => {
  it('refuses a cursor whose types are not the mapped columns', async () => {
    const jira = await site([
      catalogue,
      searchPages({ '': page([issue(1)], 'token-2'), 'token-2': page([issue(2)]) }),
    ]);
    const pageOf = pullVerbOf(jira);
    const section = { fields: { points: 'customfield_10016' } };
    const first = await pageOf({ arguments: { jql: 'project = EX' }, section });
    if (!first.ok || first.value.cursor === undefined) throw new Error('no second page');
    const cursor = decodeCursor(first.value.cursor);
    if (typeof cursor === 'string') throw new Error(cursor);
    expect(cursor.m).toEqual({ points: 'number' });
    const forged = encodeCursor({ ...cursor, m: { points: 'blob' } });
    const second = await pageOf({ arguments: { jql: 'project = EX' }, section, cursor: forged });
    expect(second.ok ? [] : second.error.map((item) => item.message)).toEqual([
      "'jira.pull' failed: E_JIRA_CONFIG: the jira section changed during the pull; run again.",
    ]);
  });
});
