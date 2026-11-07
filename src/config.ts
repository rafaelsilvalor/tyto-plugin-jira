import type { PluginHost } from '@tyto/plugin-api';

import { hostCodeOf, jiraError, jiraOk, messageOf, type JiraResult } from './errors.js';

/** Everything a request to one Jira site needs. The token never leaves this object. */
export interface JiraConfig {
  /** The site's origin, `https://<site>.atlassian.net`, with no path and no trailing slash. */
  readonly baseUrl: string;
  readonly email: string;
  readonly token: string;
}

/** The parts of the host the configuration is read from. */
export type ConfigHost = Pick<PluginHost, 'config' | 'credentials'>;

/** The schema `host.config` asks for. Typed off the host so the plugin needs no Zod of its own. */
type ConfigSchema = Parameters<PluginHost['config']>[0];

/**
 * Hands `host.config` the plugin's own record unchecked, and lets {@link resolveJiraConfig}
 * check each value.
 *
 * `host.config` only calls `safeParse` on what it is given, and throws on a refusal. Bundling
 * Zod to say "two nullable strings" would multiply `dist/index.js` many times over, and a throw
 * is the wrong answer for a typo in `settings.json`: the host has already replaced a value its
 * declared form refused with the default, so what arrives here is a string or `null`.
 */
const RAW_RECORD = {
  safeParse: (value: unknown) => ({ success: true as const, data: value }),
} as unknown as ConfigSchema;

const CLOUD_DOMAIN = '.atlassian.net';

const NOT_CLOUD =
  'Only Jira Cloud on <site>.atlassian.net is supported. Jira Data Center and Server, and a ' +
  'Cloud site on a custom domain, are out: the plugin may reach only *.atlassian.net.';

/**
 * The site, the email and the token, or why they cannot be had — before any request.
 *
 * The site is the workspace's first: `baseUrl` in the `jira` section of `.tyto/project.json`
 * names the site a team's folder works with, and wins over the person's `jira.baseUrl` setting
 * (Tyto ADR 0147). It is checked before any secret is read, so a wrong site costs nothing.
 *
 * The token is only the `api-token` credential. The email is the `email` credential, and the
 * `jira.email` setting is a fallback used only when that credential is missing — any other
 * refusal of the credential is reported, not papered over.
 */
export async function resolveJiraConfig(
  host: ConfigHost,
  section: unknown,
): Promise<JiraResult<JiraConfig>> {
  const settings = readSettings(host);

  const sectionSite = siteInSection(section);
  if (!sectionSite.ok) return sectionSite;
  const written = sectionSite.value ?? settings.baseUrl;
  if (written === undefined) {
    return jiraError(
      'E_JIRA_CONFIG',
      'No Jira site is set. Write it as baseUrl in the jira section of .tyto/project.json, or ' +
        'as jira.baseUrl in settings.json, such as https://example.atlassian.net.',
    );
  }
  const baseUrl = cloudOrigin(written);
  if (!baseUrl.ok) return baseUrl;

  const token = await readCredential(host, 'api-token');
  if (!token.ok) return token;
  if (token.value === undefined) {
    return jiraError(
      'E_JIRA_CONFIG',
      'No Jira API token is stored. Store it as the api-token credential ' +
        '(TYTO_PLUGIN_JIRA_API_TOKEN on the command line, the keychain in the desktop).',
      { hostCode: 'E_CREDENTIAL_MISSING' },
    );
  }

  const storedEmail = await readCredential(host, 'email');
  if (!storedEmail.ok) return storedEmail;
  const email = storedEmail.value ?? settings.email;
  if (email === undefined) {
    return jiraError(
      'E_JIRA_CONFIG',
      'No email for the Jira API token. Store it as the email credential ' +
        '(TYTO_PLUGIN_JIRA_EMAIL on the command line), or write it as jira.email in settings.json.',
      { hostCode: 'E_CREDENTIAL_MISSING' },
    );
  }

  return jiraOk({ baseUrl: baseUrl.value, email, token: token.value });
}

/**
 * `https://<site>.atlassian.net`, from what somebody wrote, or why it is refused.
 *
 * A path is refused rather than dropped: Jira Cloud serves its API at the site's root, so a
 * path means somebody pasted a page's address, or a Server install under a context path.
 */
export function cloudOrigin(written: string): JiraResult<string> {
  let url: URL;
  try {
    url = new URL(written.trim());
  } catch {
    return jiraError('E_JIRA_CONFIG', `'${written}' is not a URL. ${NOT_CLOUD}`);
  }
  if (url.protocol !== 'https:') {
    return jiraError('E_JIRA_CONFIG', `'${written}' is not https. ${NOT_CLOUD}`);
  }
  const site = url.hostname.slice(0, -CLOUD_DOMAIN.length);
  if (!url.hostname.endsWith(CLOUD_DOMAIN) || site.length === 0 || site.includes('.')) {
    return jiraError('E_JIRA_CONFIG', `'${url.hostname}' is not a Jira Cloud site. ${NOT_CLOUD}`);
  }
  if (url.port !== '' || url.username !== '' || url.password !== '') {
    return jiraError(
      'E_JIRA_CONFIG',
      `'${written}' carries a port or a user name; write the site alone, such as https://${url.hostname}.`,
    );
  }
  if ((url.pathname !== '/' && url.pathname !== '') || url.search !== '' || url.hash !== '') {
    return jiraError(
      'E_JIRA_CONFIG',
      `'${written}' carries a path; write the site alone, such as https://${url.hostname}.`,
    );
  }
  return jiraOk(url.origin);
}

interface Settings {
  readonly baseUrl?: string;
  readonly email?: string;
}

function readSettings(host: ConfigHost): Settings {
  const raw = host.config(RAW_RECORD);
  if (typeof raw !== 'object' || raw === null) return {};
  const record = raw as Readonly<Record<string, unknown>>;
  const baseUrl = nonEmptyString(record['baseUrl']);
  const email = nonEmptyString(record['email']);
  return {
    ...(baseUrl === undefined ? {} : { baseUrl }),
    ...(email === undefined ? {} : { email }),
  };
}

/** The section's `baseUrl`; absent when the folder has no section or the section names none. */
function siteInSection(section: unknown): JiraResult<string | undefined> {
  if (section === undefined || section === null) return jiraOk(undefined);
  if (typeof section !== 'object' || Array.isArray(section)) {
    return jiraError('E_JIRA_CONFIG', 'The jira section of .tyto/project.json is not an object.');
  }
  const value = (section as Readonly<Record<string, unknown>>)['baseUrl'];
  if (value === undefined || value === null) return jiraOk(undefined);
  if (typeof value !== 'string' || value.trim() === '') {
    return jiraError(
      'E_JIRA_CONFIG',
      'baseUrl in the jira section of .tyto/project.json is not a URL, such as https://example.atlassian.net.',
    );
  }
  return jiraOk(value);
}

/** The credential, `undefined` when the host holds none, or the host's other refusals. */
async function readCredential(
  host: ConfigHost,
  key: 'api-token' | 'email',
): Promise<JiraResult<string | undefined>> {
  try {
    return jiraOk(nonEmptyString(await host.credentials(key)));
  } catch (thrown) {
    const hostCode = hostCodeOf(thrown);
    if (hostCode === 'E_CREDENTIAL_MISSING') return jiraOk(undefined);
    return jiraError(
      'E_JIRA_CONFIG',
      `Tyto could not read the ${key} credential: ${messageOf(thrown)}`,
      hostCode === undefined ? {} : { hostCode },
    );
  }
}

function nonEmptyString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() !== '' ? value.trim() : undefined;
}
