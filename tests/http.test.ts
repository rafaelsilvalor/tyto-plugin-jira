import { describe, expect, it } from 'vitest';

import type { JiraConfig } from '../src/config.js';
import { base64, createJiraClient, type JiraFetch } from '../src/http.js';
import { hostResponse, jiraHost, response, type FakeRequest } from './host.js';

const CONFIG: JiraConfig = {
  baseUrl: 'https://example.atlassian.net',
  email: 'person@example.com',
  token: 'test-token-not-real',
};
const ENCODED = base64(`${CONFIG.email}:${CONFIG.token}`);

/** A fake `fetch` that answers in turn, and records what it was asked. */
function scripted(...answers: ReturnType<typeof hostResponse>[]) {
  const requests: FakeRequest[] = [];
  const fetch: JiraFetch = async (url, init = {}) => {
    requests.push({ url, init });
    const next = answers.shift();
    if (next === undefined) throw new Error(`no answer left for ${url}`);
    return next;
  };
  const waits: number[] = [];
  const sleep = async (milliseconds: number) => {
    waits.push(milliseconds);
  };
  return { requests, waits, client: createJiraClient({ fetch, config: CONFIG, sleep }) };
}

describe('createJiraClient', () => {
  it('asks /myself with Basic auth, and answers the account', async () => {
    const { client, requests } = scripted(
      hostResponse(200, { accountId: 'abc-123', displayName: 'A Person', active: true }),
    );
    expect(await client.myself()).toEqual({
      ok: true,
      value: { accountId: 'abc-123', displayName: 'A Person' },
    });
    expect(requests).toEqual([
      {
        url: 'https://example.atlassian.net/rest/api/3/myself',
        init: {
          method: 'GET',
          headers: {
            Accept: 'application/json',
            Authorization: `Basic ${ENCODED}`,
            'X-Atlassian-Token': 'no-check',
          },
        },
      },
    ]);
  });

  it('sends a query on a GET and JSON on a POST', async () => {
    const { client, requests } = scripted(hostResponse(200, { a: 1 }), hostResponse(204));
    expect(await client.get('/rest/api/3/field', { expand: 'names', maxResults: 50 })).toEqual({
      ok: true,
      value: { a: 1 },
    });
    expect(await client.post('/rest/api/3/search/jql', { jql: 'project = X' })).toEqual({
      ok: true,
      value: null,
    });
    expect(requests[0]?.url).toBe(
      'https://example.atlassian.net/rest/api/3/field?expand=names&maxResults=50',
    );
    expect(requests[1]?.init).toMatchObject({
      method: 'POST',
      body: '{"jql":"project = X"}',
      headers: { 'Content-Type': 'application/json' },
    });
  });

  it('opts out of the XSRF check on every POST and PUT', async () => {
    const { client, requests } = scripted(
      hostResponse(200, {}),
      hostResponse(204),
      hostResponse(204),
      hostResponse(201, {}),
    );
    await client.post('/rest/api/3/issue/bulkfetch', { issueIdsOrKeys: ['EX-1'] });
    await client.post('/rest/api/3/issue/EX-1/transitions', { transition: { id: '11' } });
    await client.put('/rest/api/3/issue/EX-1', { fields: {} });
    await client.post('/rest/api/3/issue/EX-1/comment', { body: {} });
    expect(requests).toHaveLength(4);
    for (const request of requests) {
      expect(request.init.method).not.toBe('GET');
      expect(request.init.headers).toMatchObject({ 'X-Atlassian-Token': 'no-check' });
    }
  });

  it('says plainly when the 403 is Jira refusing the XSRF check', async () => {
    const { client } = scripted(hostResponse(403, 'XSRF check failed'));
    const answer = await client.post('/rest/api/3/issue/bulkfetch', { issueIdsOrKeys: ['EX-1'] });
    const error = answer.ok ? undefined : answer.error;
    expect(error).toMatchObject({ code: 'E_JIRA_AUTH', status: 403 });
    expect(error?.message).toContain("Jira's XSRF check refused POST /rest/api/3/issue/bulkfetch");
    expect(error?.message).toContain('The account and the token are not the problem.');
    expect(error?.message).not.toContain('CAPTCHA');
  });

  it('keeps the permission reading for any other 403', async () => {
    const { client } = scripted(hostResponse(403, { errorMessages: ['Nope'] }));
    const answer = await client.post('/rest/api/3/issue/bulkfetch', {});
    expect(answer.ok ? undefined : answer.error.message).toContain('CAPTCHA');
  });

  it.each([401, 403])(
    'answers %i as E_JIRA_AUTH, naming the email and the site',
    async (status) => {
      const { client } = scripted(hostResponse(status, { errorMessages: ['Nope'] }));
      const answer = await client.myself();
      expect(answer.ok ? undefined : answer.error).toMatchObject({
        code: 'E_JIRA_AUTH',
        status,
        message: expect.stringContaining('person@example.com on https://example.atlassian.net'),
      });
    },
  );

  it('retries a 429 and a 503, honouring Retry-After, and backs off without it', async () => {
    const { client, waits, requests } = scripted(
      hostResponse(429, '', { 'Retry-After': '7' }),
      hostResponse(503),
      hostResponse(200, { accountId: 'abc-123' }),
    );
    const answer = await client.myself();
    expect(answer.ok).toBe(true);
    expect(waits).toEqual([7000, 2000]);
    expect(requests).toHaveLength(3);
  });

  it(`gives up after 3 retries`, async () => {
    const { client, requests } = scripted(
      hostResponse(429),
      hostResponse(429),
      hostResponse(429),
      hostResponse(429),
      hostResponse(200, { accountId: 'never-reached' }),
    );
    const answer = await client.myself();
    expect(answer.ok ? undefined : answer.error).toMatchObject({
      code: 'E_JIRA_HTTP',
      status: 429,
    });
    expect(requests).toHaveLength(4);
  });

  it('does not sleep through a Retry-After over 30 s', async () => {
    const { client, waits } = scripted(hostResponse(429, '', { 'retry-after': '31' }));
    const answer = await client.myself();
    expect(answer.ok ? undefined : answer.error.message).toContain('wait 31 s');
    expect(waits).toEqual([]);
  });

  it('never follows a redirect', async () => {
    const { client, requests } = scripted(
      hostResponse(302, '', { Location: 'https://elsewhere.example/login' }),
      hostResponse(200, { accountId: 'never-reached' }),
    );
    const answer = await client.myself();
    expect(answer.ok ? undefined : answer.error).toMatchObject({
      code: 'E_JIRA_REDIRECT',
      status: 302,
      message: expect.stringContaining('https://elsewhere.example/login'),
    });
    expect(requests).toHaveLength(1);
  });

  it("answers any other status as E_JIRA_HTTP, quoting Jira's words", async () => {
    const { client } = scripted(
      hostResponse(400, { errorMessages: ['The JQL is wrong.'], errors: { jql: 'bad' } }),
    );
    const answer = await client.post('/rest/api/3/search/jql', { jql: '=' });
    expect(answer.ok ? undefined : answer.error).toMatchObject({
      code: 'E_JIRA_HTTP',
      status: 400,
      message: expect.stringContaining('The JQL is wrong.; jql: bad'),
    });
  });

  it('never repeats the token, nor the header made from it, in a message', async () => {
    const echoed = `bad token ${CONFIG.token}, header Basic ${ENCODED}`;
    for (const status of [302, 400, 403, 500]) {
      const { client } = scripted(
        hostResponse(
          status,
          { errorMessages: [echoed] },
          { location: `https://x/${CONFIG.token}` },
        ),
      );
      const answer = await client.get('/rest/api/3/myself');
      const message = answer.ok ? '' : answer.error.message;
      expect(message).toContain('[redacted]');
      expect(message).not.toContain(CONFIG.token);
      expect(message).not.toContain(ENCODED);
    }
  });

  it('answers a 2xx that is not JSON as E_JIRA_RESPONSE', async () => {
    const { client } = scripted(hostResponse(200, '<html>login</html>'));
    const answer = await client.get('/rest/api/3/myself');
    expect(answer.ok ? undefined : answer.error.code).toBe('E_JIRA_RESPONSE');
  });

  it('refuses a path that would leave the site, without a request', async () => {
    const { client, requests } = scripted();
    for (const path of ['//elsewhere.example/x', 'https://elsewhere.example/x', 'rest/api/3']) {
      const answer = await client.get(path);
      expect(answer.ok ? undefined : answer.error.code).toBe('E_JIRA_CONFIG');
    }
    expect(requests).toEqual([]);
  });
});

describe("the client over Tyto's host", () => {
  it('reaches an atlassian.net site through the permission', async () => {
    const { host, requests } = jiraHost({
      fetch: async () => response(200, { accountId: 'abc-123' }),
    });
    const client = createJiraClient({ fetch: host.fetch, config: CONFIG });
    expect((await client.myself()).ok).toBe(true);
    expect(requests.map((request) => request.url)).toEqual([
      'https://example.atlassian.net/rest/api/3/myself',
    ]);
  });

  it('is refused by Tyto with E_PERMISSION for a host outside atlassian.net', async () => {
    const { host, requests } = jiraHost({
      fetch: async () => response(200, { accountId: 'abc-123' }),
    });
    const client = createJiraClient({
      fetch: host.fetch,
      config: { ...CONFIG, baseUrl: 'https://jira.example.com' },
    });
    const answer = await client.myself();
    expect(answer.ok ? undefined : answer.error).toMatchObject({
      code: 'E_JIRA_NETWORK',
      hostCode: 'E_PERMISSION',
    });
    expect(requests).toEqual([]);
  });
});

describe('base64', () => {
  it.each([
    ['', ''],
    ['f', 'Zg=='],
    ['fo', 'Zm8='],
    ['foo', 'Zm9v'],
    ['person@example.com:token', 'cGVyc29uQGV4YW1wbGUuY29tOnRva2Vu'],
    ['é', 'w6k='],
  ])('encodes %j as %s', (text, encoded) => {
    expect(base64(text)).toBe(encoded);
  });
});
