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
]);
const SECTION = {
  fields: {
    points: 'customfield_10016',
    team: 'customfield_10020',
    reviewer: 'customfield_10030',
    notes: 'customfield_10040',
    sprint: 'customfield_10050',
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
