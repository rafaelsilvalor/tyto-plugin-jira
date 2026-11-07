import { afterEach, describe, expect, it } from 'vitest';

import { APPLY_BUDGET_MILLISECONDS, NOT_REACHED } from '../src/write/apply.js';
import { applyTransitions, planTransitions } from '../src/transition.js';
import { jiraHost, response } from './host.js';
import { EMAIL, SITE, TOKEN, fakeSite, type FakeSite, type Route } from './jira.js';
import {
  SEARCH,
  callsAfter,
  jiraWrites,
  planAndApply,
  pulled,
  type FakeIssue,
  type Transitions,
} from './writes.js';

/**
 * `jira.transition` through `testPlugin`: the committed bundle plans a cell over an input
 * table, and the harness's registry applies the plan it showed, as the notebook's Apply does.
 */
let open: FakeSite | undefined;
async function site(routes: readonly Route[], section: unknown = SECTION): Promise<FakeSite> {
  open = await fakeSite(routes, { section });
  return open;
}
afterEach(async () => {
  await open?.plugin.close();
  open = undefined;
});

/** A synthetic delivery workflow: To Do → In Progress → Review → Done, and Blocked aside. */
const DELIVERY = {
  'To Do': ['In Progress', 'Blocked'],
  'In Progress': ['Review', 'Blocked'],
  Review: ['Done', 'In Progress'],
  Blocked: ['To Do'],
};
const SECTION = { workflows: { delivery: DELIVERY } };

const JIRA_TRANSITIONS: Transitions = {
  'To Do': [
    ['11', 'Start', 'In Progress'],
    ['12', 'Block', 'Blocked'],
  ],
  'In Progress': [
    ['21', 'Send to review', 'Review'],
    ['22', 'Block', 'Blocked'],
  ],
  Review: [
    ['31', 'Approve', 'Done'],
    ['32', 'Reopen', 'In Progress'],
  ],
  Blocked: [['41', 'Unblock', 'To Do']],
};

function issues(entries: Readonly<Record<string, string>>): Map<string, FakeIssue> {
  return new Map(Object.entries(entries).map(([key, status]) => [key, { status, assignee: null }]));
}

describe('jira.transition plans', () => {
  it('the shortest path through the workflow, and reads no Jira', async () => {
    const jira = await site([jiraWrites(issues({}), JIRA_TRANSITIONS)]);
    const ran = await jira.plugin.runRecipe('jira.transition to=Done workflow=delivery', {
      input: pulled([
        ['EX-1', 'To Do'],
        ['EX-2', 'Review'],
        ['EX-3', 'Done'],
      ]),
    });
    if (!ran.ok) throw new Error('the recipe did not run');
    expect(ran.value.cells[0]?.plan).toEqual({
      target: 'Jira example.atlassian.net',
      count: 2,
      operations: [
        {
          write: 'transition',
          rowKey: 'EX-1',
          description: 'EX-1: To Do → In Progress → Review → Done',
          payload: { k: 'EX-1', f: 'To Do', p: ['In Progress', 'Review', 'Done'], w: 'delivery' },
        },
        {
          write: 'transition',
          rowKey: 'EX-2',
          description: 'EX-2: Review → Done',
          payload: { k: 'EX-2', f: 'Review', p: ['Done'], w: 'delivery' },
        },
      ],
    });
    expect(jira.calls).toEqual([]);
  });

  it('a status the workflow cannot reach as a planned failure naming what it tried', async () => {
    const jira = await site([jiraWrites(issues({ 'EX-1': 'Done' }), JIRA_TRANSITIONS)]);
    const answer = await planAndApply(
      jira,
      'jira.transition to=Blocked workflow=delivery',
      pulled([['EX-1', 'Done']]),
    );
    const reason =
      'E_JIRA_CONFIG: workflow delivery has no path from Done to Blocked; Done has no transition in it';
    expect(answer.plan?.operations[0]).toMatchObject({ payload: { x: reason } });
    expect(answer.plan?.operations[0]?.description).toContain('will fail');
    expect(answer.applied).toEqual([{ status: 'failed', reason }]);
    expect(jira.calls).toEqual([]);

    const blocked = await site([jiraWrites(issues({}), JIRA_TRANSITIONS)], {
      workflows: { oneway: { 'To Do': ['In Progress'], 'In Progress': ['Review'] } },
    });
    const tried = await planAndApply(
      blocked,
      'jira.transition to=Done workflow=oneway',
      pulled([['EX-2', 'To Do']]),
    );
    expect(tried.applied?.[0]?.reason).toBe(
      'E_JIRA_CONFIG: workflow oneway has no path from To Do to Done; the paths tried from ' +
        'To Do reach only In Progress, Review',
    );
  });

  it('refuses a workflow= the section does not hold, naming the ones it does', async () => {
    const jira = await site([]);
    const answer = await planAndApply(
      jira,
      'jira.transition to=Done workflow=release',
      pulled([['EX-1', 'To Do']]),
    );
    expect(answer.diagnostics).toEqual([
      {
        code: 'E_RECIPE_ARGUMENTS',
        message:
          "'jira.transition' names workflow=release, which the workflows of the jira section of " +
          '.tyto/project.json do not hold (delivery).',
      },
    ]);
    expect(answer.plan).toBeUndefined();
  });

  it('refuses a table without a status column', async () => {
    const jira = await site([]);
    const answer = await planAndApply(jira, 'jira.transition to=Done', {
      columns: [{ name: 'key', type: 'text', origin: 'sheet' }],
      rows: [],
    });
    expect(answer.diagnostics.map((each) => each.code)).toEqual(['E_RECIPE_ARGUMENTS']);
  });

  it('keeps a payload over 2 KiB out of the plan, as a planned failure of that row', async () => {
    const statuses = Array.from({ length: 30 }, (_, index) => `Stage ${index} ${'x'.repeat(70)}`);
    const long = Object.fromEntries(
      statuses.slice(0, -1).map((status, index) => [status, [statuses[index + 1] as string]]),
    );
    const jira = await site([], { workflows: { long } });
    const answer = await planAndApply(
      jira,
      `jira.transition to="${statuses.at(-1) ?? ''}" workflow=long`,
      pulled([
        ['EX-1', statuses[0] ?? null],
        ['EX-2', statuses[27] ?? null],
      ]),
    );
    expect(answer.diagnostics).toEqual([]);
    const [over, under] = answer.plan?.operations ?? [];
    expect(over?.payload).toEqual({
      x: expect.stringMatching(
        /^E_JIRA_PLAN: EX-1: this write needs 2,\d{3} bytes to be kept with the plan, over the 2,048/,
      ) as unknown,
    });
    expect(under?.payload).toMatchObject({ k: 'EX-2' });
    expect(answer.applied?.[0]?.status).toBe('failed');
  });
});

describe('jira.transition applies', () => {
  it('walks a 3-step path with 3 GET and 3 POST after one search', async () => {
    const state = issues({ 'EX-1': 'To Do' });
    const jira = await site([jiraWrites(state, JIRA_TRANSITIONS)]);
    const answer = await planAndApply(
      jira,
      'jira.transition to=Done workflow=delivery',
      pulled([['EX-1', 'To Do']]),
    );
    expect(answer.applied).toEqual([
      { status: 'applied', reason: 'walked To Do → In Progress → Review → Done' },
    ]);
    expect(callsAfter(jira, answer.planCalls)).toEqual([
      `POST ${SEARCH}`,
      ...Array.from({ length: 3 }, () => [
        'GET /rest/api/3/issue/EX-1/transitions',
        'POST /rest/api/3/issue/EX-1/transitions',
      ]).flat(),
    ]);
    expect(jira.calls.filter((call) => call.method === 'POST').slice(1)).toMatchObject(
      ['11', '21', '31'].map((id) => ({ body: { transition: { id } } })),
    );
    expect(state.get('EX-1')?.status).toBe('Done');
  });

  it('takes one direct step without workflow=', async () => {
    const state = issues({ 'EX-1': 'Review' });
    const jira = await site([jiraWrites(state, JIRA_TRANSITIONS)], null);
    const answer = await planAndApply(
      jira,
      'jira.transition to=done',
      pulled([['EX-1', 'Review']]),
    );
    expect(answer.plan?.operations[0]?.payload).toEqual({ k: 'EX-1', f: 'Review', p: ['done'] });
    expect(answer.applied).toEqual([{ status: 'applied', reason: 'walked Review → Done' }]);
  });

  it('fails an issue that moved off the path since the plan, and applies the others', async () => {
    const state = issues({ 'EX-1': 'To Do', 'EX-2': 'In Progress' });
    const jira = await site([jiraWrites(state, JIRA_TRANSITIONS)]);
    const answer = await planAndApply(
      jira,
      'jira.transition to=Review workflow=delivery',
      pulled([
        ['EX-1', 'To Do'],
        ['EX-2', 'In Progress'],
      ]),
      () => {
        (state.get('EX-1') as FakeIssue).status = 'Blocked';
      },
    );
    expect(answer.applied).toEqual([
      {
        status: 'failed',
        reason: 'E_JIRA_MOVED: EX-1 moved from To Do to Blocked since the plan; run the cell again',
      },
      { status: 'applied', reason: 'walked In Progress → Review' },
    ]);
    expect(callsAfter(jira, answer.planCalls).filter((call) => call.includes('EX-1'))).toEqual([]);
  });

  it('resumes a walk from a status on its path', async () => {
    const state = issues({ 'EX-1': 'To Do' });
    const jira = await site([jiraWrites(state, JIRA_TRANSITIONS)]);
    const answer = await planAndApply(
      jira,
      'jira.transition to=Done workflow=delivery',
      pulled([['EX-1', 'To Do']]),
      () => {
        (state.get('EX-1') as FakeIssue).status = 'Review';
      },
    );
    expect(answer.applied).toEqual([
      { status: 'applied', reason: 'walked Review → Done (resumed at Review)' },
    ]);
    expect(callsAfter(jira, answer.planCalls)).toHaveLength(3);
  });

  it('writes nothing for an issue already at the target', async () => {
    const state = issues({ 'EX-1': 'To Do' });
    const jira = await site([jiraWrites(state, JIRA_TRANSITIONS)]);
    const answer = await planAndApply(
      jira,
      'jira.transition to=Done workflow=delivery',
      pulled([['EX-1', 'To Do']]),
      () => {
        (state.get('EX-1') as FakeIssue).status = 'Done';
      },
    );
    expect(answer.applied).toEqual([
      { status: 'applied', reason: 'already Done; nothing written' },
    ]);
    expect(callsAfter(jira, answer.planCalls)).toEqual([`POST ${SEARCH}`]);
  });

  it('fails a step two transitions lead to, or none, naming them, after the steps it walked', async () => {
    const state = issues({ 'EX-1': 'To Do', 'EX-2': 'To Do' });
    const jira = await site([
      jiraWrites(state, {
        ...JIRA_TRANSITIONS,
        'In Progress': [
          ['21', 'Send to review', 'Review'],
          ['23', 'Fast review', 'review'],
        ],
      }),
    ]);
    const answer = await planAndApply(
      jira,
      'jira.transition to=Review workflow=delivery',
      pulled([
        ['EX-1', 'To Do'],
        ['EX-2', 'Blocked'],
      ]),
      () => {
        (state.get('EX-2') as FakeIssue).status = 'Blocked';
      },
    );
    expect(answer.applied?.[0]).toEqual({
      status: 'failed',
      reason:
        'E_JIRA_TRANSITION: EX-1 offers 2 transitions from In Progress to Review, Send to ' +
        'review (to Review), Fast review (to review), and cannot tell which is meant; walked ' +
        'To Do → In Progress before this',
    });
    // Blocked → To Do → In Progress → Review per the workflow; Jira offers Blocked only Unblock.
    expect(answer.applied?.[1]?.status).toBe('failed');

    const none = await site([jiraWrites(issues({ 'EX-3': 'Review' }), { Review: [] })], null);
    const nothing = await planAndApply(
      none,
      'jira.transition to=Done',
      pulled([['EX-3', 'Review']]),
    );
    expect(nothing.applied).toEqual([
      {
        status: 'failed',
        reason: 'E_JIRA_TRANSITION: EX-3 offers no transition from Review to Done; it offers none',
      },
    ]);
  });

  it('fails every operation after a 401 with E_JIRA_AUTH, and asks Jira nothing more', async () => {
    const state = issues({ 'EX-1': 'Review', 'EX-2': 'Review', 'EX-3': 'Review' });
    const refuse: Route = (call) =>
      call.path === '/rest/api/3/issue/EX-2/transitions' ? response(401) : undefined;
    const jira = await site([refuse, jiraWrites(state, JIRA_TRANSITIONS)], null);
    const answer = await planAndApply(
      jira,
      'jira.transition to=Done',
      pulled([
        ['EX-1', 'Review'],
        ['EX-2', 'Review'],
        ['EX-3', 'Review'],
      ]),
    );
    expect(answer.applied?.map((each) => each.status)).toEqual(['applied', 'failed', 'failed']);
    expect(answer.applied?.[1]?.reason).toMatch(/^E_JIRA_AUTH: Jira refused the API token/);
    expect(answer.applied?.[2]?.reason).toBe(answer.applied?.[1]?.reason);
    expect(callsAfter(jira, answer.planCalls).some((call) => call.includes('EX-3'))).toBe(false);
  });

  it('retries a 429 and then writes', async () => {
    const state = issues({ 'EX-1': 'Review' });
    let limited = 0;
    const busy: Route = (call) =>
      call.method === 'POST' && call.path.endsWith('/transitions') && limited++ === 0
        ? response(429, '', { 'Retry-After': '0' })
        : undefined;
    const jira = await site([busy, jiraWrites(state, JIRA_TRANSITIONS)], null);
    const answer = await planAndApply(
      jira,
      'jira.transition to=Done',
      pulled([['EX-1', 'Review']]),
    );
    expect(answer.applied).toEqual([{ status: 'applied', reason: 'walked Review → Done' }]);
    expect(
      callsAfter(jira, answer.planCalls).filter((call) =>
        call.startsWith('POST /rest/api/3/issue'),
      ),
    ).toHaveLength(2);
  });

  it('never puts the token in a reason or a payload, even when Jira echoes it', async () => {
    const state = issues({ 'EX-1': 'Review' });
    const echo: Route = (call) =>
      call.method === 'POST' && call.path.endsWith('/transitions')
        ? response(400, { errorMessages: [`bad request from ${TOKEN}`] })
        : undefined;
    const jira = await site([echo, jiraWrites(state, JIRA_TRANSITIONS)], null);
    const answer = await planAndApply(
      jira,
      'jira.transition to=Done',
      pulled([['EX-1', 'Review']]),
    );
    expect(answer.applied?.[0]?.reason).toMatch(/^E_JIRA_HTTP: .*\[redacted\]/);
    expect(JSON.stringify([answer.plan, answer.applied])).not.toContain(TOKEN);
  });
});

describe('the apply budget', () => {
  it('skips the operations the call has no time left for', async () => {
    const state = issues({ 'EX-1': 'Review', 'EX-2': 'Review', 'EX-3': 'Review' });
    const route = jiraWrites(state, JIRA_TRANSITIONS);
    let now = 0;
    const { host } = jiraHost({
      settings: { baseUrl: SITE, email: EMAIL },
      secrets: { 'api-token': TOKEN },
      async fetch(url, init) {
        // Every request takes eight seconds of the clock the apply reads.
        now += 8_000;
        const parsed = new URL(url);
        const call = {
          method: init.method ?? 'GET',
          path: parsed.pathname,
          query: {},
          body: typeof init.body === 'string' ? (JSON.parse(init.body) as unknown) : undefined,
        };
        const answer = route(call);
        if (answer === undefined) throw new Error(`no route for ${call.path}`);
        return answer;
      },
    });
    const table = pulled([
      ['EX-1', 'Review'],
      ['EX-2', 'Review'],
      ['EX-3', 'Review'],
    ]);
    const planned = await planTransitions(host, { arguments: { to: 'Done' }, table });
    if (!planned.ok) throw new Error('the plan was refused');
    const applied = await applyTransitions(
      host,
      { arguments: { to: 'Done' }, operations: planned.value.operations, target: 'x' },
      { now: () => now },
    );
    if (!applied.ok) throw new Error('the apply was refused');
    // Search (8 s), EX-1's GET and POST (24 s): past the 20 s budget before EX-2.
    expect(APPLY_BUDGET_MILLISECONDS).toBe(20_000);
    expect(applied.value.operations).toEqual([
      { status: 'applied', reason: 'walked Review → Done' },
      { status: 'skipped', reason: NOT_REACHED },
      { status: 'skipped', reason: NOT_REACHED },
    ]);
    expect(state.get('EX-2')?.status).toBe('Review');
  });
});
