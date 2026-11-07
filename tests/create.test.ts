import { afterEach, describe, expect, it } from 'vitest';

import { response } from './host.js';
import { TOKEN, fakeSite, route, type FakeSite, type JiraCall, type Route } from './jira.js';
import { callsAfter, planAndApply, SEARCH, type InputTable } from './writes.js';

/** `jira.create` through `testPlugin`, planned over a sheet and applied as shown. */
let open: FakeSite[] = [];
async function site(routes: readonly Route[]): Promise<FakeSite> {
  const opened = await fakeSite([catalogue, ...routes], { section: SECTION });
  open.push(opened);
  return opened;
}
afterEach(async () => {
  for (const each of open) await each.plugin.close();
  open = [];
});

const BULK = '/rest/api/3/issue/bulk';
const catalogue = route('GET', '/rest/api/3/field', [
  { id: 'customfield_10016', name: 'Story points', schema: { type: 'number' } },
  { id: 'customfield_10020', name: 'Team', schema: { type: 'option' } },
  { id: 'customfield_10050', name: 'Sprint', schema: { type: 'array', items: 'json' } },
]);
const SECTION = { fields: { points: 'customfield_10016', team: 'customfield_10020' } };
const STEP = 'jira.create project=EX type=Task summary=title description=body parent=epic';

interface Created {
  readonly key: string;
  readonly fields: Record<string, unknown>;
}

/**
 * A Jira that creates: the bulk endpoint numbers each new issue `EX-<n>` and keeps it, and the
 * search answers `labels in (...)` from what it kept. `refuse` names the elements Jira turns
 * down, with its words; `lost` makes the answer of a bulk that did create never arrive.
 */
function creating(
  created: Created[],
  options: {
    refuse?: (fields: Record<string, unknown>) => string | undefined;
    lost?: () => boolean;
  } = {},
): Route {
  return (call: JiraCall) => {
    if (call.method === 'POST' && call.path === SEARCH) {
      const { jql } = call.body as { jql: string };
      const labels = /^labels in \(([^)]*)\)/
        .exec(jql)?.[1]
        ?.split(', ')
        .map((each) => JSON.parse(each) as string);
      if (labels === undefined) return undefined;
      const issues = created
        .filter(({ fields }) =>
          (fields['labels'] as string[]).some((label) => labels.includes(label)),
        )
        .map(({ key, fields }) => ({
          id: key.slice(3),
          key,
          fields: { labels: fields['labels'] },
        }));
      return response(200, { issues, isLast: true });
    }
    if (call.method !== 'POST' || call.path !== BULK) return undefined;
    const { issueUpdates } = call.body as { issueUpdates: { fields: Record<string, unknown> }[] };
    const issues: { id: string; key: string; self: string }[] = [];
    const errors: unknown[] = [];
    issueUpdates.forEach(({ fields }, index) => {
      const refusal = options.refuse?.(fields);
      if (refusal !== undefined) {
        errors.push({
          status: 400,
          elementErrors: { errorMessages: [], errors: { summary: refusal } },
          failedElementNumber: index,
        });
        return;
      }
      const key = `EX-${created.length + 1}`;
      created.push({ key, fields });
      issues.push({
        id: String(created.length),
        key,
        self: `https://example.atlassian.net/${key}`,
      });
    });
    if (options.lost?.() === true) throw new Error('the connection was reset');
    return response(issues.length === 0 ? 400 : 201, { issues, errors });
  };
}

function sheet(
  rows: readonly Readonly<Record<string, string | number | null>>[],
  extra: InputTable['columns'] = [],
): InputTable {
  return {
    columns: [
      { name: 'title', type: 'text', origin: 'sheet' },
      { name: 'body', type: 'text', origin: 'sheet' },
      { name: 'epic', type: 'text', origin: 'sheet' },
      ...extra,
    ],
    rows: rows.map((values, index) => ({
      key: `row-${index + 1}`,
      values: { title: null, body: null, epic: null, ...values },
      provenance: { source: 'sheet', id: String(index + 1), fetchedAt: '2026-11-01T00:00:00.000Z' },
    })),
  };
}

const bulkCalls = (jira: FakeSite): JiraCall[] =>
  jira.calls.filter((call) => call.method === 'POST' && call.path === BULK);

describe('jira.create', () => {
  it('creates each row in one bulk request, labelled, and answers the new key', async () => {
    const created: Created[] = [];
    const jira = await site([creating(created)]);
    const table = sheet(
      [
        {
          title: 'First',
          body: 'See https://docs.example.com/a.',
          epic: 'EX-100',
          points: 3,
          team: 'Blue',
        },
        { title: 'Second', points: null },
      ],
      [
        { name: 'points', type: 'number', origin: 'sheet' },
        { name: 'team', type: 'text', origin: 'sheet' },
      ],
    );
    const answer = await planAndApply(jira, STEP, table);
    expect(answer.diagnostics).toEqual([]);
    const [first, second] = answer.plan?.operations ?? [];
    expect(first?.description).toBe('EX: create Task "First" under EX-100');
    expect(first?.payload).toEqual({
      p: 'EX',
      t: 'Task',
      s: 'First',
      d: 'See https://docs.example.com/a.',
      par: 'EX-100',
      m: { customfield_10016: 3, customfield_10020: { value: 'Blue' } },
      tok: expect.stringMatching(/^tyto-[0-9a-f]{16}$/),
    });
    expect(second?.payload).toEqual({
      p: 'EX',
      t: 'Task',
      s: 'Second',
      m: {},
      tok: expect.any(String),
    });
    expect(answer.applied).toEqual([
      { status: 'applied', reason: 'created EX-1' },
      { status: 'applied', reason: 'created EX-2' },
    ]);
    expect(callsAfter(jira, answer.planCalls)).toEqual([`POST ${SEARCH}`, `POST ${BULK}`]);
    const sent = (
      bulkCalls(jira)[0]?.body as { issueUpdates: { fields: Record<string, unknown> }[] }
    ).issueUpdates;
    expect(sent[0]?.fields).toEqual({
      customfield_10016: 3,
      customfield_10020: { value: 'Blue' },
      project: { key: 'EX' },
      issuetype: { name: 'Task' },
      summary: 'First',
      description: expect.objectContaining({ type: 'doc' }),
      parent: { key: 'EX-100' },
      labels: [first?.payload && (first.payload as { tok: string }).tok],
    });
    expect(sent[1]?.fields).not.toHaveProperty('customfield_10016');
  });

  it('gives the same row the same label, and another row or project another', async () => {
    const jira = await site([creating([])]);
    const table = sheet([{ title: 'One' }, { title: 'Two' }]);
    const tokens = async (step: string) =>
      (await planAndApply(jira, step, table)).plan?.operations.map(
        (operation) => (operation.payload as { tok: string }).tok,
      ) ?? [];
    const first = await tokens('jira.create project=EX type=Task summary=title');
    const again = await tokens('jira.create project=EX type=Task summary=title');
    const other = await tokens('jira.create project=OT type=Task summary=title');
    expect(again).toEqual(first);
    expect(new Set([...first, ...other]).size).toBe(4);
  });

  it('after a bulk whose answer never came, applying again finds the label and creates nothing', async () => {
    const created: Created[] = [];
    let lose = true;
    const jira = await site([creating(created, { lost: () => lose })]);
    const ran = await jira.plugin.runRecipe(STEP, { input: sheet([{ title: 'Only once' }]) });
    if (!ran.ok) throw new Error('the step did not run');
    const plan = ran.value.cells.at(-1)?.plan;
    const verb = jira.plugin.recipes.verbs.get('jira.create');
    if (plan === undefined || verb?.apply === undefined) throw new Error('no plan');

    const first = await verb.apply(plan);
    expect(first.ok && first.value.operations[0]?.reason).toMatch(
      /^E_JIRA_NETWORK: POST \/rest\/api\/3\/issue\/bulk got no answer/,
    );
    lose = false;
    const second = await verb.apply(plan);
    expect(
      second.ok && second.value.operations.map(({ status, reason }) => ({ status, reason })),
    ).toEqual([{ status: 'applied', reason: 'already created EX-1; nothing written' }]);
    expect(created.map(({ key }) => key)).toEqual(['EX-1']);
    expect(bulkCalls(jira)).toHaveLength(1);
  });

  it('maps one refused element back to its row, and creates the others', async () => {
    const created: Created[] = [];
    const refuse = (fields: Record<string, unknown>) =>
      fields['summary'] === 'Bad' ? 'The summary is not allowed.' : undefined;
    const jira = await site([creating(created, { refuse })]);
    const rows = Array.from({ length: 60 }, (_, index) => ({
      title: index === 1 ? 'Bad' : `Row ${index + 1}`,
    }));
    const answer = await planAndApply(
      jira,
      'jira.create project=EX type=Task summary=title',
      sheet(rows),
    );
    expect(
      bulkCalls(jira).map((call) => (call.body as { issueUpdates: unknown[] }).issueUpdates.length),
    ).toEqual([50, 10]);
    expect(answer.applied?.slice(0, 3)).toEqual([
      { status: 'applied', reason: 'created EX-1' },
      {
        status: 'failed',
        reason:
          'E_JIRA_HTTP: Jira refused to create it (400): summary: The summary is not allowed.',
      },
      { status: 'applied', reason: 'created EX-2' },
    ]);
    expect(answer.applied?.at(-1)).toEqual({ status: 'applied', reason: 'created EX-59' });
    expect(created).toHaveLength(59);
  });

  it('maps the elements of a bulk Jira refused whole (400) to their rows', async () => {
    const jira = await site([creating([], { refuse: () => 'Field required.' })]);
    const answer = await planAndApply(
      jira,
      'jira.create project=EX type=Task summary=title',
      sheet([{ title: 'A' }, { title: 'B' }]),
    );
    expect(answer.applied).toEqual([
      {
        status: 'failed',
        reason: 'E_JIRA_HTTP: Jira refused to create it (400): summary: Field required.',
      },
      {
        status: 'failed',
        reason: 'E_JIRA_HTTP: Jira refused to create it (400): summary: Field required.',
      },
    ]);
  });

  it('plans a row too large to keep, or without a summary, as a failure of that row alone', async () => {
    const jira = await site([creating([])]);
    const long = 'é'.repeat(700);
    const answer = await planAndApply(
      jira,
      STEP,
      sheet(
        [{ title: 'Too large', body: long, team: long }, { title: '' }, { title: 'Fine' }],
        [{ name: 'team', type: 'text', origin: 'sheet' }],
      ),
    );
    expect(answer.applied?.[0]?.reason).toMatch(
      /^E_JIRA_PLAN: this write needs 2,\d{3} bytes to be kept with the plan, over the 2,048/,
    );
    expect(answer.applied?.[1]).toEqual({
      status: 'failed',
      reason: 'E_JIRA_PLAN: row row-2 has no text in title',
    });
    expect(answer.applied?.[2]).toEqual({ status: 'applied', reason: 'created EX-1' });
    expect(bulkCalls(jira)).toHaveLength(1);
  });

  it('plans a mapped cell its field cannot take as a failure of that row', async () => {
    const jira = await site([creating([])]);
    const answer = await planAndApply(
      jira,
      'jira.create project=EX type=Task summary=title',
      sheet([{ title: 'A', points: 'many' }], [{ name: 'points', type: 'text', origin: 'sheet' }]),
    );
    expect(answer.applied).toEqual([
      { status: 'failed', reason: 'E_JIRA_PLAN: row row-1: "many" is not a number for points' },
    ]);
  });

  it.each([
    [
      'jira.create project=ex type=Task summary=title',
      "project= is 'ex', which is not a project key, such as EX",
    ],
    [
      'jira.create project=EX type=Task summary=name',
      "summary= names 'name', which is not a column of the table",
    ],
  ])('refuses %s with E_RECIPE_ARGUMENTS', async (step, message) => {
    const jira = await site([]);
    const answer = await planAndApply(jira, step, sheet([{ title: 'A' }]));
    expect(answer.diagnostics).toEqual([
      { code: 'E_RECIPE_ARGUMENTS', message: `'jira.create' ${message}.` },
    ]);
  });

  it('fails every row after a 401, and creates nothing more', async () => {
    const refuse: Route = (call) => (call.path === BULK ? response(401) : undefined);
    const jira = await site([refuse, creating([])]);
    const rows = Array.from({ length: 51 }, (_, index) => ({ title: `Row ${index + 1}` }));
    const answer = await planAndApply(
      jira,
      'jira.create project=EX type=Task summary=title',
      sheet(rows),
    );
    expect(answer.applied?.[0]?.reason).toMatch(/^E_JIRA_AUTH: Jira refused the API token/);
    expect(new Set(answer.applied?.map(({ reason }) => reason)).size).toBe(1);
    expect(bulkCalls(jira)).toHaveLength(1);
  });

  it('never puts the token in a reason or a payload, even when Jira echoes it', async () => {
    const jira = await site([creating([], { refuse: () => `bad ${TOKEN}` })]);
    const answer = await planAndApply(
      jira,
      'jira.create project=EX type=Task summary=title',
      sheet([{ title: 'A' }]),
    );
    expect(answer.applied?.[0]?.reason).toContain('[redacted]');
    expect(JSON.stringify([answer.plan, answer.applied])).not.toContain(TOKEN);
  });
});
