import { afterEach, describe, expect, it } from 'vitest';

import { response } from './host.js';
import { TOKEN, fakeSite, type FakeSite, type Route } from './jira.js';
import { ME, callsAfter, jiraWrites, planAndApply, pulled, type FakeIssue } from './writes.js';

/** `jira.assign` through `testPlugin`, planned over an input table and applied as shown. */
let open: FakeSite | undefined;
async function site(routes: readonly Route[]): Promise<FakeSite> {
  open = await fakeSite(routes);
  return open;
}
afterEach(async () => {
  await open?.plugin.close();
  open = undefined;
});

const ALICE = { accountId: '557058:aaaaaaaa-0000-4000-8000-000000000002', displayName: 'Alice' };
const BRUNO = { accountId: '5b10ac8d82e05b22cc7d4ef5', displayName: 'Bruno' };

const OWNER = [{ name: 'owner', type: 'text', origin: 'sheet' }] as const;

function state(entries: Readonly<Record<string, FakeIssue['assignee']>>): Map<string, FakeIssue> {
  return new Map(
    Object.entries(entries).map(([key, assignee]) => [key, { status: 'To Do', assignee }]),
  );
}

describe('jira.assign', () => {
  it('assigns each issue to the account id of its to= column with one PUT', async () => {
    const issues = state({ 'EX-1': ALICE, 'EX-2': null });
    const jira = await site([jiraWrites(issues)]);
    const answer = await planAndApply(
      jira,
      'jira.assign to=owner',
      pulled(
        [
          ['EX-1', 'To Do', 'Alice'],
          ['EX-2', 'To Do', null],
        ],
        [...OWNER],
        { 'EX-1': { owner: BRUNO.accountId }, 'EX-2': { owner: ALICE.accountId } },
      ),
    );
    expect(answer.plan?.operations).toEqual([
      {
        write: 'assign',
        rowKey: 'EX-1',
        description: `EX-1: Alice → ${BRUNO.accountId}`,
        payload: { k: 'EX-1', f: 'Alice', t: BRUNO.accountId },
      },
      {
        write: 'assign',
        rowKey: 'EX-2',
        description: `EX-2: ${ALICE.accountId}`,
        payload: { k: 'EX-2', f: null, t: ALICE.accountId },
      },
    ]);
    expect(answer.planCalls).toBe(0);
    expect(answer.applied).toEqual([{ status: 'applied' }, { status: 'applied' }]);
    expect(jira.calls.filter((call) => call.method === 'PUT')).toMatchObject([
      { path: '/rest/api/3/issue/EX-1/assignee', body: { accountId: BRUNO.accountId } },
      { path: '/rest/api/3/issue/EX-2/assignee', body: { accountId: ALICE.accountId } },
    ]);
  });

  it("assigns to the token's own account with me, reading it once, and unassigns with none", async () => {
    const issues = state({ 'EX-1': null, 'EX-2': ALICE });
    const jira = await site([jiraWrites(issues)]);
    const table = pulled([
      ['EX-1', 'To Do', null],
      ['EX-2', 'To Do', 'Alice'],
    ]);
    const mine = await planAndApply(jira, 'jira.assign to=me', table);
    expect(mine.plan?.operations[1]?.payload).toEqual({ k: 'EX-2', f: 'Alice', me: true });
    expect(mine.applied).toEqual([{ status: 'applied' }, { status: 'applied' }]);
    expect(
      callsAfter(jira, mine.planCalls).filter((call) => call.endsWith('/myself')),
    ).toHaveLength(1);
    expect(issues.get('EX-1')?.assignee?.accountId).toBe(ME.accountId);

    // The fake names an account it assigned by the id's last four digits.
    const nobody = await planAndApply(
      jira,
      'jira.assign to=none',
      pulled([['EX-2', 'To Do', 'Person 0001']]),
    );
    expect(nobody.plan?.operations[0]?.payload).toEqual({ k: 'EX-2', f: 'Person 0001', t: null });
    expect(nobody.applied).toEqual([{ status: 'applied' }]);
    expect(issues.get('EX-2')?.assignee).toBeNull();
  });

  it('fails an issue reassigned since the plan, and writes nothing to it', async () => {
    const issues = state({ 'EX-1': ALICE });
    const jira = await site([jiraWrites(issues)]);
    const answer = await planAndApply(
      jira,
      'jira.assign to=owner',
      pulled([['EX-1', 'To Do', 'Alice']], [...OWNER], { 'EX-1': { owner: BRUNO.accountId } }),
      () => {
        (issues.get('EX-1') as FakeIssue).assignee = {
          accountId: '557058:cccccccc-0000-4000-8000-000000000003',
          displayName: 'Carla',
        };
      },
    );
    expect(answer.applied).toEqual([
      {
        status: 'failed',
        reason:
          'E_JIRA_MOVED: EX-1 was assigned to Alice when planned and is assigned to Carla now; ' +
          'run the cell again',
      },
    ]);
    expect(jira.calls.some((call) => call.method === 'PUT')).toBe(false);
  });

  it('writes nothing to an issue already assigned to the target', async () => {
    const issues = state({ 'EX-1': BRUNO });
    const jira = await site([jiraWrites(issues)]);
    const answer = await planAndApply(
      jira,
      'jira.assign to=owner',
      pulled([['EX-1', 'To Do', 'Alice']], [...OWNER], { 'EX-1': { owner: BRUNO.accountId } }),
    );
    expect(answer.applied).toEqual([
      { status: 'applied', reason: 'already assigned to Bruno; nothing written' },
    ]);
    expect(jira.calls.some((call) => call.method === 'PUT')).toBe(false);
  });

  it('plans a name, an email or an empty cell as a failure of that row alone', async () => {
    const jira = await site([jiraWrites(state({ 'EX-3': null }))]);
    const answer = await planAndApply(
      jira,
      'jira.assign to=owner',
      pulled(
        [
          ['EX-1', 'To Do'],
          ['EX-2', 'To Do'],
          ['EX-3', 'To Do'],
        ],
        [...OWNER],
        {
          'EX-1': { owner: 'person@example.com' },
          'EX-2': { owner: null },
          'EX-3': { owner: BRUNO.accountId },
        },
      ),
    );
    expect(answer.applied).toEqual([
      {
        status: 'failed',
        reason:
          'E_JIRA_PLAN: "person@example.com" in owner is not a Jira account id; write the id, ' +
          'not a name or an email',
      },
      { status: 'failed', reason: 'E_JIRA_PLAN: EX-2 has no account id in owner' },
      { status: 'applied' },
    ]);
    expect(callsAfter(jira, answer.planCalls).filter((call) => call.startsWith('PUT'))).toEqual([
      'PUT /rest/api/3/issue/EX-3/assignee',
    ]);
  });

  it('refuses a to= that is neither me, none nor a column', async () => {
    const jira = await site([]);
    const answer = await planAndApply(jira, 'jira.assign to=lead', pulled([['EX-1', 'To Do']]));
    expect(answer.diagnostics).toEqual([
      {
        code: 'E_RECIPE_ARGUMENTS',
        message:
          "'jira.assign' to= names 'lead', which is neither me, none nor a column of the table " +
          'holding account ids.',
      },
    ]);
  });

  it('keeps the token out of a failed PUT the site echoed it in', async () => {
    const echo: Route = (call) =>
      call.method === 'PUT' ? response(400, { errors: { assignee: `no ${TOKEN}` } }) : undefined;
    const jira = await site([echo, jiraWrites(state({ 'EX-1': null }))]);
    const answer = await planAndApply(jira, 'jira.assign to=me', pulled([['EX-1', 'To Do']]));
    expect(answer.applied?.[0]?.reason).toMatch(/^E_JIRA_HTTP: PUT .*\[redacted\]/);
    expect(JSON.stringify([answer.plan, answer.applied])).not.toContain(TOKEN);
  });
});
