import { afterEach, describe, expect, it } from 'vitest';

import { response } from './host.js';
import { TOKEN, fakeSite, type FakeSite, type Route } from './jira.js';
import { ME, callsAfter, jiraWrites, planAndApply, pulled, type FakeIssue } from './writes.js';

/** `jira.comment` through `testPlugin`, planned over an input table and applied as shown. */
let open: FakeSite | undefined;
async function site(routes: readonly Route[]): Promise<FakeSite> {
  open = await fakeSite(routes);
  return open;
}
afterEach(async () => {
  await open?.plugin.close();
  open = undefined;
});

const NOTE = [{ name: 'note', type: 'text', origin: 'sheet' }] as const;
const OTHER = { accountId: '557058:bbbbbbbb-0000-4000-8000-000000000009' };
const TEXT = 'Released today.\nThanks all.\n\nNotes: https://docs.example.com/notes.';
const DOCUMENT = {
  type: 'doc',
  version: 1,
  content: [
    {
      type: 'paragraph',
      content: [
        { type: 'text', text: 'Released today.' },
        { type: 'hardBreak' },
        { type: 'text', text: 'Thanks all.' },
      ],
    },
    {
      type: 'paragraph',
      content: [
        { type: 'text', text: 'Notes: ' },
        {
          type: 'text',
          text: 'https://docs.example.com/notes',
          marks: [{ type: 'link', attrs: { href: 'https://docs.example.com/notes' } }],
        },
        { type: 'text', text: '.' },
      ],
    },
  ],
};

function state(comments: FakeIssue['comments'] = []): Map<string, FakeIssue> {
  return new Map([
    ['EX-1', { status: 'To Do', assignee: null, comments: [...comments] }],
    ['EX-2', { status: 'To Do', assignee: null }],
  ]);
}

function notes(values: Readonly<Record<string, string | null>>) {
  return pulled(
    Object.keys(values).map((key) => [key, 'To Do'] as const),
    [...NOTE],
    Object.fromEntries(Object.entries(values).map(([key, note]) => [key, { note }])),
  );
}

describe('jira.comment', () => {
  it('posts the text as a document of paragraphs and links, planning with no request', async () => {
    const issues = state();
    const jira = await site([jiraWrites(issues)]);
    const answer = await planAndApply(jira, 'jira.comment body=note', notes({ 'EX-1': TEXT }));
    expect(answer.planCalls).toBe(0);
    expect(answer.plan?.operations).toEqual([
      {
        write: 'comment',
        rowKey: 'EX-1',
        description:
          'EX-1: comment "Released today. Thanks all. Notes: https://docs.example.com/notes."',
        payload: { k: 'EX-1', b: TEXT },
      },
    ]);
    expect(answer.applied).toEqual([{ status: 'applied' }]);
    expect(
      jira.calls.filter((call) => call.method === 'POST' && call.path.endsWith('/comment')),
    ).toEqual([
      expect.objectContaining({ path: '/rest/api/3/issue/EX-1/comment', body: { body: DOCUMENT } }),
    ]);
    expect(
      jira.calls.find((call) => call.method === 'GET' && call.path.endsWith('/comment'))?.query,
    ).toEqual({ orderBy: '-created', maxResults: '50' });
  });

  it('comments once when applied twice, and again when another account said the same', async () => {
    const issues = state([{ author: OTHER, body: DOCUMENT }]);
    const jira = await site([jiraWrites(issues)]);
    const table = notes({ 'EX-1': TEXT });
    const first = await planAndApply(jira, 'jira.comment body=note', table);
    expect(first.applied).toEqual([{ status: 'applied' }]);
    const again = await planAndApply(jira, 'jira.comment body=note', table);
    expect(again.applied).toEqual([
      { status: 'applied', reason: 'already commented; nothing written' },
    ]);
    expect(issues.get('EX-1')?.comments?.map((each) => each.author.accountId)).toEqual([
      OTHER.accountId,
      ME.accountId,
    ]);
  });

  it('plans an empty cell and a text over 1,500 bytes as failures of their rows alone', async () => {
    const jira = await site([jiraWrites(state())]);
    const answer = await planAndApply(
      jira,
      'jira.comment body=note',
      notes({ 'EX-1': 'é'.repeat(751), 'EX-2': null, 'EX-3': 'é'.repeat(750) }),
    );
    expect(answer.plan?.operations.map((each) => each.payload)).toEqual([
      {
        x: "E_JIRA_PLAN: EX-1's comment is 1,502 bytes, over the 1,500 a plan carries; shorten it",
      },
      { x: 'E_JIRA_PLAN: EX-2 has no text in note' },
      { k: 'EX-3', b: 'é'.repeat(750) },
    ]);
    expect(answer.applied?.slice(0, 2).map((each) => each.status)).toEqual(['failed', 'failed']);
    expect(callsAfter(jira, answer.planCalls).some((call) => /EX-[12]\//.test(call))).toBe(false);
  });

  it('refuses a body= that is not a column of the table', async () => {
    const jira = await site([]);
    const answer = await planAndApply(jira, 'jira.comment body=text', notes({ 'EX-1': 'Hi' }));
    expect(answer.diagnostics).toEqual([
      {
        code: 'E_RECIPE_ARGUMENTS',
        message: "'jira.comment' body= names 'text', which is not a column of the table.",
      },
    ]);
  });

  it('fails every operation after a 401 with E_JIRA_AUTH, and asks Jira nothing more', async () => {
    const refuse: Route = (call) =>
      call.method === 'GET' && call.path === '/rest/api/3/issue/EX-1/comment'
        ? response(401)
        : undefined;
    const jira = await site([refuse, jiraWrites(state())]);
    const answer = await planAndApply(
      jira,
      'jira.comment body=note',
      notes({ 'EX-1': 'One', 'EX-2': 'Two' }),
    );
    expect(answer.applied?.[0]?.reason).toMatch(/^E_JIRA_AUTH: Jira refused the API token/);
    expect(answer.applied?.[1]).toEqual(answer.applied?.[0]);
    expect(callsAfter(jira, answer.planCalls).some((call) => call.includes('EX-2/'))).toBe(false);
  });

  it('retries a 429 and then posts', async () => {
    let limited = 0;
    const busy: Route = (call) =>
      call.method === 'POST' && call.path.endsWith('/comment') && limited++ === 0
        ? response(429, '', { 'Retry-After': '0' })
        : undefined;
    const jira = await site([busy, jiraWrites(state())]);
    const answer = await planAndApply(jira, 'jira.comment body=note', notes({ 'EX-1': 'Hi' }));
    expect(answer.applied).toEqual([{ status: 'applied' }]);
    expect(
      callsAfter(jira, answer.planCalls).filter((call) =>
        call.startsWith('POST /rest/api/3/issue'),
      ),
    ).toHaveLength(2);
  });

  it('never puts the token in a reason or a payload, even when Jira echoes it', async () => {
    const echo: Route = (call) =>
      call.method === 'POST' && call.path.endsWith('/comment')
        ? response(400, { errorMessages: [`bad comment from ${TOKEN}`] })
        : undefined;
    const jira = await site([echo, jiraWrites(state())]);
    const answer = await planAndApply(jira, 'jira.comment body=note', notes({ 'EX-1': 'Hi' }));
    expect(answer.applied?.[0]?.reason).toMatch(/^E_JIRA_HTTP: POST .*\[redacted\]/);
    expect(JSON.stringify([answer.plan, answer.applied])).not.toContain(TOKEN);
  });
});
