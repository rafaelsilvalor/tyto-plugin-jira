import { afterEach, describe, expect, it } from 'vitest';

import { response } from './host.js';
import { TOKEN, fakeSite, memoryCache, route, type FakeSite, type Route } from './jira.js';
import { callsAfter, jiraWrites, planAndApply, pulled, type FakeIssue } from './writes.js';

/** `jira.set` through `testPlugin`, planned over an input table and applied as shown. */
let open: FakeSite[] = [];
async function site(
  routes: readonly Route[],
  cache?: ReturnType<typeof memoryCache>,
): Promise<FakeSite> {
  const opened = await fakeSite([catalogue, ...routes], {
    section: SECTION,
    ...(cache === undefined ? {} : { capabilities: cache.capabilities }),
  });
  open.push(opened);
  return opened;
}
afterEach(async () => {
  for (const each of open) await each.plugin.close();
  open = [];
});

const TEXTAREA = 'com.atlassian.jira.plugin.system.customfieldtypes:textarea';
const catalogue = route('GET', '/rest/api/3/field', [
  { id: 'summary', name: 'Summary', schema: { type: 'string', system: 'summary' } },
  { id: 'customfield_10016', name: 'Story points', schema: { type: 'number' } },
  { id: 'customfield_10020', name: 'Team', schema: { type: 'option' } },
  { id: 'customfield_10030', name: 'Reviewer', schema: { type: 'user' } },
  { id: 'customfield_10040', name: 'Notes', schema: { type: 'string', custom: TEXTAREA } },
  { id: 'customfield_10050', name: 'Sprint', schema: { type: 'array', items: 'json' } },
  { id: 'customfield_10060', name: 'Area', schema: { type: 'string' } },
]);
const SECTION = {
  fields: {
    points: 'customfield_10016',
    team: 'customfield_10020',
    reviewer: 'customfield_10030',
    notes: 'customfield_10040',
    sprint: 'customfield_10050',
    area: 'customfield_10060',
    gone: 'customfield_99999',
  },
};
const NEW = [{ name: 'new', type: 'text', origin: 'sheet' }] as const;
const ACCOUNT = '557058:aaaaaaaa-0000-4000-8000-000000000002';

function state(fields: Record<string, unknown> = {}): Map<string, FakeIssue> {
  return new Map([
    ['EX-1', { status: 'To Do', assignee: null, fields: { ...fields } }],
    ['EX-2', { status: 'To Do', assignee: null, fields: { ...fields } }],
  ]);
}

/** One row, EX-1, whose `new` column holds the cell. */
function oneRow(cell: string) {
  return pulled([['EX-1', 'To Do']], [...NEW], { 'EX-1': { new: cell } });
}

describe('jira.set', () => {
  it.each([
    ['points', '5', 'customfield_10016', 5],
    ['team', 'Blue', 'customfield_10020', { value: 'Blue' }],
    ['reviewer', ACCOUNT, 'customfield_10030', { accountId: ACCOUNT }],
    ['duedate', '2026-12-01', 'duedate', '2026-12-01'],
    ['labels', 'alpha, beta gamma', 'labels', ['alpha', 'beta', 'gamma']],
    ['priority', 'High', 'priority', { name: 'High' }],
    ['summary', 'A new title', 'summary', 'A new title'],
    [
      'notes',
      'Line one\nline two\n\nSee https://docs.example.com/a.',
      'customfield_10040',
      {
        type: 'doc',
        version: 1,
        content: [
          {
            type: 'paragraph',
            content: [
              { type: 'text', text: 'Line one' },
              { type: 'hardBreak' },
              { type: 'text', text: 'line two' },
            ],
          },
          {
            type: 'paragraph',
            content: [
              { type: 'text', text: 'See ' },
              {
                type: 'text',
                text: 'https://docs.example.com/a',
                marks: [{ type: 'link', attrs: { href: 'https://docs.example.com/a' } }],
              },
              { type: 'text', text: '.' },
            ],
          },
        ],
      },
    ],
  ])('writes %s from %j as its type takes it, with one PUT', async (field, cell, id, value) => {
    const jira = await site([jiraWrites(state())]);
    const answer = await planAndApply(jira, `jira.set field=${field} value=new`, oneRow(cell));
    expect(answer.diagnostics).toEqual([]);
    expect(answer.plan?.operations[0]?.payload).toEqual({ k: 'EX-1', fid: id, v: value });
    expect(answer.applied).toEqual([{ status: 'applied' }]);
    expect(jira.calls.filter((call) => call.method === 'PUT')).toEqual([
      expect.objectContaining({
        path: '/rest/api/3/issue/EX-1',
        body: { fields: { [id]: value } },
      }),
    ]);
  });

  it('plans from the cached field catalogue, and reads nothing else', async () => {
    const cache = memoryCache();
    const jira = await site([jiraWrites(state())], cache);
    const first = await planAndApply(jira, 'jira.set field=points value=new', oneRow('3'));
    expect(callsAfter(jira, 0).slice(0, first.planCalls)).toEqual(['GET /rest/api/3/field']);
    const before = jira.calls.length;
    const second = await planAndApply(jira, 'jira.set field=points value=new', oneRow('4'));
    expect(callsAfter(jira, before).slice(0, second.planCalls - before)).toEqual([]);
    expect(second.applied).toEqual([{ status: 'applied' }]);
  });

  it('fails an issue whose field changed since the plan, and writes nothing to it', async () => {
    const issues = state({ customfield_10016: 3 });
    const jira = await site([jiraWrites(issues)]);
    const table = pulled(
      [
        ['EX-1', 'To Do'],
        ['EX-2', 'To Do'],
      ],
      [{ name: 'points', type: 'number', origin: 'jira' }, ...NEW],
      { 'EX-1': { points: 3, new: '5' }, 'EX-2': { points: 3, new: '5' } },
    );
    const answer = await planAndApply(jira, 'jira.set field=points value=new', table, () => {
      (issues.get('EX-1') as FakeIssue).fields = { customfield_10016: 8 };
    });
    expect(answer.plan?.operations[0]?.description).toBe('EX-1: points 3 → 5');
    expect(answer.applied).toEqual([
      {
        status: 'failed',
        reason:
          "E_JIRA_MOVED: EX-1's customfield_10016 is 8 now, not what the table read when " +
          'planned; run the cell again',
      },
      { status: 'applied' },
    ]);
    expect(callsAfter(jira, answer.planCalls).filter((call) => call.startsWith('PUT'))).toEqual([
      'PUT /rest/api/3/issue/EX-2',
    ]);
  });

  it('writes nothing to an issue that already holds the value', async () => {
    const jira = await site([jiraWrites(state({ labels: ['beta', 'alpha'] }))]);
    const answer = await planAndApply(
      jira,
      'jira.set field=labels value=new',
      oneRow('alpha beta'),
    );
    expect(answer.applied).toEqual([
      { status: 'applied', reason: 'already labels = beta, alpha; nothing written' },
    ]);
    expect(jira.calls.some((call) => call.method === 'PUT')).toBe(false);
  });

  it.each([
    [
      'owner',
      "field= names 'owner', which is neither a column the fields of the jira section map nor summary, labels, duedate or priority",
    ],
    ['gone', 'field= names gone, mapped to customfield_99999, and this site has no such field'],
    ['sprint', 'field= names sprint, a field of type array of json, which it cannot write'],
  ])('refuses field=%s with E_RECIPE_ARGUMENTS', async (field, message) => {
    const jira = await site([]);
    const answer = await planAndApply(jira, `jira.set field=${field} value=new`, oneRow('x'));
    expect(answer.diagnostics).toEqual([
      { code: 'E_RECIPE_ARGUMENTS', message: `'jira.set' ${message}.` },
    ]);
    expect(answer.plan).toBeUndefined();
  });

  it('plans a cell its field cannot take as a failure of that row alone', async () => {
    const jira = await site([jiraWrites(state())]);
    const table = pulled(
      [
        ['EX-1', 'To Do'],
        ['EX-2', 'To Do'],
      ],
      [...NEW],
      { 'EX-1': { new: 'many' }, 'EX-2': { new: '2' } },
    );
    const answer = await planAndApply(jira, 'jira.set field=points value=new', table);
    expect(answer.applied).toEqual([
      { status: 'failed', reason: 'E_JIRA_PLAN: EX-1: "many" is not a number for points' },
      { status: 'applied' },
    ]);
    const reviewer = await planAndApply(
      jira,
      'jira.set field=reviewer value=new',
      oneRow('person@example.com'),
    );
    expect(reviewer.applied?.[0]?.reason).toBe(
      'E_JIRA_PLAN: EX-1: "person@example.com" is not a Jira account id for reviewer; write ' +
        'the id, not a name or an email',
    );
  });

  it.each([
    ['a text column', { name: 'points_push', type: 'text', origin: 'recipe' }, '5', ''],
    ['a text column of blanks', { name: 'points_push', type: 'text', origin: 'recipe' }, '5', '  '],
    ['a boolean column', { name: 'points_push', type: 'boolean', origin: 'recipe' }, true, false],
  ] as const)(
    'with only= naming %s, plans the chosen rows and nothing for the others',
    async (_, column, chosen, skipped) => {
      const jira = await site([jiraWrites(state())]);
      const table = pulled(
        [
          ['EX-1', 'To Do'],
          ['EX-2', 'To Do'],
        ],
        [...NEW, column],
        { 'EX-1': { new: '5', points_push: chosen }, 'EX-2': { new: '8', points_push: skipped } },
      );
      const answer = await planAndApply(
        jira,
        'jira.set field=points value=new only=points_push',
        table,
      );
      expect(answer.diagnostics).toEqual([]);
      expect(answer.plan?.operations.map((each) => each.payload)).toEqual([
        { k: 'EX-1', fid: 'customfield_10016', v: 5 },
      ]);
      expect(answer.applied).toEqual([{ status: 'applied' }]);
      expect(callsAfter(jira, answer.planCalls).filter((call) => call.startsWith('PUT'))).toEqual([
        'PUT /rest/api/3/issue/EX-1',
      ]);
    },
  );

  it('with only=, still fails a chosen row alone and skips a row with no key', async () => {
    const jira = await site([jiraWrites(state())]);
    const push = { name: 'points_push', type: 'text', origin: 'recipe' } as const;
    const read = pulled(
      [
        ['EX-1', 'To Do'],
        ['EX-2', 'To Do'],
      ],
      [...NEW, push],
      { 'EX-1': { new: 'many', points_push: 'many' }, 'EX-2': { new: '2', points_push: '2' } },
    );
    const noKey = {
      key: 'r3',
      values: { key: null, status: null, assignee: null, new: '3', points_push: null },
      provenance: { source: 'sheet', id: 'r3', fetchedAt: '2026-11-01T00:00:00.000Z' },
    };
    const table = { ...read, rows: [...read.rows, noKey] };
    const answer = await planAndApply(
      jira,
      'jira.set field=points value=points_push only=points_push',
      table,
    );
    expect(answer.applied).toEqual([
      { status: 'failed', reason: 'E_JIRA_PLAN: EX-1: "many" is not a number for points' },
      { status: 'applied' },
    ]);
  });

  /**
   * A table as `jira.refresh prefix=jira_` and `decide <field> ... clear=push` leave it: the
   * Jira column, the decided `<field>_push` and the `<field>_pushes` boolean, one row per issue.
   */
  function decided(
    field: string,
    jiraType: 'text' | 'number' | 'date' | 'list',
    rows: Readonly<Record<string, { jira: unknown; push: unknown; pushes: boolean }>>,
  ) {
    return pulled(
      Object.keys(rows).map((key) => [key, 'To Do'] as const),
      [
        { name: `jira_${field}`, type: jiraType, origin: 'jira' },
        { name: `${field}_push`, type: jiraType, origin: 'recipe' },
        { name: `${field}_pushes`, type: 'boolean', origin: 'recipe' },
      ],
      Object.fromEntries(
        Object.entries(rows).map(([key, row]) => [
          key,
          {
            [`jira_${field}`]: row.jira,
            [`${field}_push`]: row.push,
            [`${field}_pushes`]: row.pushes,
          },
        ]),
      ) as Parameters<typeof pulled>[2],
    );
  }

  it.each([
    ['team', 'option', 'customfield_10020', { value: 'Blue' }, 'text', 'Blue', null],
    [
      'reviewer',
      'user',
      'customfield_10030',
      { accountId: ACCOUNT, displayName: 'A reviewer' },
      'text',
      'A reviewer',
      null,
    ],
    ['area', 'text', 'customfield_10060', 'North wing', 'text', 'North wing', null],
    [
      'notes',
      'paragraph',
      'customfield_10040',
      {
        type: 'doc',
        version: 1,
        content: [{ type: 'paragraph', content: [{ type: 'text', text: 'Old note' }] }],
      },
      'text',
      'Old note',
      null,
    ],
    ['points', 'number', 'customfield_10016', 3, 'number', 3, null],
    ['duedate', 'date', 'duedate', '2026-12-01', 'date', '2026-12-01', null],
    ['labels', 'list of text', 'labels', ['alpha'], 'list', ['alpha'], []],
  ] as const)(
    'with only=%s_pushes, a %s field cleared in the sheet since the last run plans clearing it',
    async (field, _type, id, held, jiraType, read, cleared) => {
      const jira = await site([jiraWrites(state({ [id]: held }))]);
      const table = decided(field, jiraType, {
        'EX-1': { jira: read, push: null, pushes: true },
        'EX-2': { jira: read, push: null, pushes: false },
      });
      const answer = await planAndApply(
        jira,
        `jira.set field=${field} value=${field}_push only=${field}_pushes from-column=jira_${field}`,
        table,
      );
      expect(answer.diagnostics).toEqual([]);
      expect(answer.plan?.operations.map((each) => each.payload)).toEqual([
        expect.objectContaining({ k: 'EX-1', fid: id, v: cleared }),
      ]);
      expect(answer.applied).toEqual([{ status: 'applied' }]);
      expect(jira.calls.filter((call) => call.method === 'PUT')).toEqual([
        expect.objectContaining({
          path: '/rest/api/3/issue/EX-1',
          body: { fields: { [id]: cleared } },
        }),
      ]);
    },
  );

  it('with only=<field>_pushes, plans nothing for a row never filled', async () => {
    const jira = await site([jiraWrites(state())]);
    const table = decided('team', 'text', {
      'EX-1': { jira: null, push: null, pushes: false },
      'EX-2': { jira: null, push: '', pushes: false },
    });
    const answer = await planAndApply(
      jira,
      'jira.set field=team value=team_push only=team_pushes from-column=jira_team',
      table,
    );
    expect(answer.diagnostics).toEqual([]);
    expect(answer.plan?.operations ?? []).toEqual([]);
    expect(jira.calls.some((call) => call.method === 'PUT')).toBe(false);
  });

  it.each([
    ['priority', 'a priority cannot be empty'],
    ['summary', 'a summary cannot be empty'],
  ])(
    'with only=%s_pushes, a cleared field Jira cannot clear is a failure of that row',
    async (field, reason) => {
      const jira = await site([jiraWrites(state())]);
      const table = decided(field, 'text', {
        'EX-1': { jira: 'High', push: null, pushes: true },
      });
      const answer = await planAndApply(
        jira,
        `jira.set field=${field} value=${field}_push only=${field}_pushes`,
        table,
      );
      expect(answer.applied).toEqual([
        { status: 'failed', reason: `E_JIRA_PLAN: EX-1: ${reason}` },
      ]);
      expect(jira.calls.some((call) => call.method === 'PUT')).toBe(false);
    },
  );

  it('with from-column=, checks the issue against that column, not the one named like the field', async () => {
    const issues = state({ customfield_10016: 3 });
    const jira = await site([jiraWrites(issues)]);
    const table = pulled(
      [['EX-1', 'To Do']],
      [
        { name: 'points', type: 'number', origin: 'sheet' },
        { name: 'jira_points', type: 'number', origin: 'jira' },
      ],
      { 'EX-1': { points: 5, jira_points: 3 } },
    );
    const step = 'jira.set field=points value=points from-column=jira_points';
    const answer = await planAndApply(jira, step, table);
    expect(answer.plan?.operations[0]?.description).toBe('EX-1: points 3 → 5');
    expect(answer.applied).toEqual([{ status: 'applied' }]);
    const moved = await planAndApply(jira, step, table, () => {
      (issues.get('EX-1') as FakeIssue).fields = { customfield_10016: 8 };
    });
    expect(moved.applied?.[0]?.reason).toMatch(/^E_JIRA_MOVED: EX-1's customfield_10016 is 8 now/);
  });

  it('refuses only= or from-column= naming a column the table lacks, before any plan', async () => {
    const jira = await site([jiraWrites(state())]);
    const answer = await planAndApply(
      jira,
      'jira.set field=points value=new only=points_push',
      oneRow('5'),
    );
    expect(answer.diagnostics).toEqual([
      {
        code: 'E_RECIPE_ARGUMENTS',
        message: "'jira.set' only= names 'points_push', which is not a column of the table.",
      },
    ]);
    expect(answer.plan).toBeUndefined();
    expect(jira.calls).toEqual([]);
    const from = await planAndApply(
      jira,
      'jira.set field=points value=new from-column=jira_points',
      oneRow('5'),
    );
    expect(from.diagnostics).toEqual([
      {
        code: 'E_RECIPE_ARGUMENTS',
        message: "'jira.set' from-column= names 'jira_points', which is not a column of the table.",
      },
    ]);
  });

  it('fails every operation after a 401 with E_JIRA_AUTH, and asks Jira nothing more', async () => {
    const refuse: Route = (call) =>
      call.method === 'PUT' && call.path === '/rest/api/3/issue/EX-1' ? response(401) : undefined;
    const jira = await site([refuse, jiraWrites(state())]);
    const table = pulled(
      [
        ['EX-1', 'To Do'],
        ['EX-2', 'To Do'],
      ],
      [...NEW],
      { 'EX-1': { new: '1' }, 'EX-2': { new: '2' } },
    );
    const answer = await planAndApply(jira, 'jira.set field=points value=new', table);
    expect(answer.applied?.[0]?.reason).toMatch(/^E_JIRA_AUTH: Jira refused the API token/);
    expect(answer.applied?.[1]).toEqual(answer.applied?.[0]);
    expect(callsAfter(jira, answer.planCalls).some((call) => call.includes('EX-2'))).toBe(false);
  });

  it('retries a 429 and then writes', async () => {
    let limited = 0;
    const busy: Route = (call) =>
      call.method === 'PUT' && limited++ === 0
        ? response(429, '', { 'Retry-After': '0' })
        : undefined;
    const jira = await site([busy, jiraWrites(state())]);
    const answer = await planAndApply(jira, 'jira.set field=points value=new', oneRow('1'));
    expect(answer.applied).toEqual([{ status: 'applied' }]);
    expect(
      callsAfter(jira, answer.planCalls).filter((call) => call.startsWith('PUT')),
    ).toHaveLength(2);
  });

  it('never puts the token in a reason or a payload, even when Jira echoes it', async () => {
    const echo: Route = (call) =>
      call.method === 'PUT'
        ? response(400, { errors: { customfield_10016: `no ${TOKEN}` } })
        : undefined;
    const jira = await site([echo, jiraWrites(state())]);
    const answer = await planAndApply(jira, 'jira.set field=points value=new', oneRow('1'));
    expect(answer.applied?.[0]?.reason).toMatch(/^E_JIRA_HTTP: PUT .*\[redacted\]/);
    expect(JSON.stringify([answer.plan, answer.applied])).not.toContain(TOKEN);
  });
});
