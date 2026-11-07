import { describe, expect, it } from 'vitest';

import { cloudOrigin, resolveJiraConfig } from '../src/config.js';
import { jiraHost } from './host.js';

const SECRETS = { 'api-token': 'test-token-not-real', email: 'stored@example.com' };

describe('resolveJiraConfig', () => {
  it('takes the site from the setting, and the token and email from the credentials', async () => {
    const { host } = jiraHost({
      settings: { baseUrl: 'https://example.atlassian.net', email: 'typed@example.com' },
      secrets: SECRETS,
    });
    expect(await resolveJiraConfig(host, undefined)).toEqual({
      ok: true,
      value: {
        baseUrl: 'https://example.atlassian.net',
        email: 'stored@example.com',
        token: 'test-token-not-real',
      },
    });
  });

  it("lets the workspace section's site win over the setting", async () => {
    const { host } = jiraHost({
      settings: { baseUrl: 'https://personal.atlassian.net', email: null },
      secrets: SECRETS,
    });
    const resolved = await resolveJiraConfig(host, {
      baseUrl: 'https://team.atlassian.net/',
      fields: {},
    });
    expect(resolved.ok && resolved.value.baseUrl).toBe('https://team.atlassian.net');
  });

  it('falls back to the email setting only when the email credential is missing', async () => {
    const { host } = jiraHost({
      settings: { baseUrl: 'https://example.atlassian.net', email: 'typed@example.com' },
      secrets: { 'api-token': 'test-token-not-real' },
    });
    const resolved = await resolveJiraConfig(host, undefined);
    expect(resolved.ok && resolved.value.email).toBe('typed@example.com');
  });

  it('names both places when neither holds the email', async () => {
    const { host } = jiraHost({
      settings: { baseUrl: 'https://example.atlassian.net', email: null },
      secrets: { 'api-token': 'test-token-not-real' },
    });
    const resolved = await resolveJiraConfig(host, undefined);
    expect(resolved.ok ? undefined : resolved.error).toMatchObject({
      code: 'E_JIRA_CONFIG',
      hostCode: 'E_CREDENTIAL_MISSING',
      message: expect.stringContaining('jira.email'),
    });
  });

  it('says where the token goes when it is missing, and never takes it from a setting', async () => {
    const { host } = jiraHost({
      settings: { baseUrl: 'https://example.atlassian.net', email: 'typed@example.com' },
      secrets: { email: 'stored@example.com' },
    });
    const resolved = await resolveJiraConfig(host, { token: 'in-the-section' });
    expect(resolved.ok ? undefined : resolved.error).toMatchObject({
      code: 'E_JIRA_CONFIG',
      message: expect.stringContaining('api-token credential'),
    });
  });

  it('asks for a site when neither the section nor the setting names one', async () => {
    const { host } = jiraHost({ secrets: SECRETS });
    const resolved = await resolveJiraConfig(host, {});
    expect(resolved.ok ? undefined : resolved.error.code).toBe('E_JIRA_CONFIG');
  });

  it('refuses a site that is not Jira Cloud before reading any secret', async () => {
    let read = 0;
    const { host } = jiraHost({ secrets: SECRETS });
    const counting = {
      config: host.config.bind(host),
      credentials: Object.assign(
        async (key: string) => {
          read += 1;
          return host.credentials(key);
        },
        { set: host.credentials.set, delete: host.credentials.delete },
      ),
    };
    const resolved = await resolveJiraConfig(counting, { baseUrl: 'https://jira.example.com' });
    expect(resolved.ok ? undefined : resolved.error.message).toContain('Data Center');
    expect(read).toBe(0);
  });

  it('refuses a section that is not an object, or whose baseUrl is not a string', async () => {
    const { host } = jiraHost({ secrets: SECRETS });
    for (const section of ['https://example.atlassian.net', { baseUrl: 42 }]) {
      const resolved = await resolveJiraConfig(host, section);
      expect(resolved.ok ? undefined : resolved.error.code).toBe('E_JIRA_CONFIG');
    }
  });
});

describe('cloudOrigin', () => {
  it.each([
    ['https://example.atlassian.net', 'https://example.atlassian.net'],
    ['https://Example.Atlassian.net/', 'https://example.atlassian.net'],
    ['  https://example.atlassian.net  ', 'https://example.atlassian.net'],
  ])('takes %j as %s', (written, origin) => {
    expect(cloudOrigin(written)).toEqual({ ok: true, value: origin });
  });

  it.each([
    'example.atlassian.net',
    'http://example.atlassian.net',
    'https://jira.example.com',
    'https://atlassian.net',
    'https://a.b.atlassian.net',
    'https://example.atlassian.net.evil.example',
    'https://example.atlassian.net:8443',
    'https://user@example.atlassian.net',
    'https://example.atlassian.net/jira',
    'https://example.atlassian.net/browse/KEY-1',
    'https://example.atlassian.net/?a=b',
  ])('refuses %j', (written) => {
    const origin = cloudOrigin(written);
    expect(origin.ok ? undefined : origin.error.code).toBe('E_JIRA_CONFIG');
  });
});
