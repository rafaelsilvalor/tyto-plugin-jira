import type { HostFetchInit, HostFetchResponse } from '@tyto/plugin-api';

import type { JiraConfig } from './config.js';
import { hostCodeOf, jiraError, jiraOk, messageOf, type JiraResult } from './errors.js';

/** `host.fetch`, or a test's stand-in for it. */
export type JiraFetch = (url: string, init?: HostFetchInit) => Promise<HostFetchResponse>;

export interface JiraClientOptions {
  readonly fetch: JiraFetch;
  readonly config: JiraConfig;
  /** Waits between retries; a test passes one that records instead of waiting. */
  readonly sleep?: (milliseconds: number) => Promise<void>;
}

/** The account the token belongs to, as `/rest/api/3/myself` answers it. */
export interface JiraAccount {
  readonly accountId: string;
  readonly displayName?: string;
  readonly emailAddress?: string;
}

export type JiraQuery = Readonly<Record<string, string | number | boolean>>;

export interface JiraClient {
  get(path: string, query?: JiraQuery): Promise<JiraResult<unknown>>;
  post(path: string, body: unknown): Promise<JiraResult<unknown>>;
  put(path: string, body: unknown): Promise<JiraResult<unknown>>;
  /** Whether the email and token work on this site, with a message a person can act on. */
  myself(): Promise<JiraResult<JiraAccount>>;
}

/** Retries after the first try, for the two answers that mean "later" (429 and 503). */
export const MAX_RETRIES = 3;
/** The longest `Retry-After` honoured; a longer wait is reported instead of slept through. */
export const MAX_RETRY_AFTER_SECONDS = 30;
/** The wait before retry n (1, 2, 4 s) when Jira does not say how long. */
const BACKOFF_MILLISECONDS = [1000, 2000, 4000] as const;

const RETRIED_STATUSES: ReadonlySet<number> = new Set([429, 503]);
/** How much of Jira's own error body a message quotes. */
const QUOTED_BODY_LIMIT = 300;
const REDACTED = '[redacted]';

const defaultSleep = (milliseconds: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, milliseconds));

/**
 * A client for one Jira Cloud site, over the host's `fetch`.
 *
 * Basic auth with the email and the API token, as Jira Cloud's REST API takes them. The
 * host's `fetch` is the only way out, so the manifest's `net:*.atlassian.net` stands in front
 * of every request, and a redirect is never followed: it comes back as `E_JIRA_REDIRECT`.
 * **No message carries the token**, nor the header made from it, even when Jira echoes them.
 */
export function createJiraClient(options: JiraClientOptions): JiraClient {
  const { fetch, config } = options;
  const sleep = options.sleep ?? defaultSleep;
  const authorization = `Basic ${base64(`${config.email}:${config.token}`)}`;
  const redact = (text: string): string =>
    [config.token, authorization.slice('Basic '.length)].reduce(
      (redacted, secret) => (secret === '' ? redacted : redacted.split(secret).join(REDACTED)),
      text,
    );

  async function request(
    method: 'GET' | 'POST' | 'PUT',
    path: string,
    query: JiraQuery | undefined,
    body: unknown,
  ): Promise<JiraResult<unknown>> {
    const url = urlOf(config.baseUrl, path, query);
    if (!url.ok) return url;
    const label = `${method} ${path}`;
    const init: HostFetchInit = {
      method,
      headers: {
        Accept: 'application/json',
        Authorization: authorization,
        ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    };

    for (let retry = 0; ; retry += 1) {
      let response: HostFetchResponse;
      try {
        response = await fetch(url.value, init);
      } catch (thrown) {
        const hostCode = hostCodeOf(thrown);
        return jiraError(
          'E_JIRA_NETWORK',
          redact(`${label} got no answer: ${messageOf(thrown)}`),
          hostCode === undefined ? {} : { hostCode },
        );
      }

      if (RETRIED_STATUSES.has(response.status)) {
        const wait = retryWait(response, retry);
        if (retry < MAX_RETRIES && wait.milliseconds !== undefined) {
          await sleep(wait.milliseconds);
          continue;
        }
        const why =
          wait.milliseconds === undefined
            ? `Jira asked to wait ${wait.seconds} s, longer than the ${MAX_RETRY_AFTER_SECONDS} s this plugin waits`
            : `still so after ${MAX_RETRIES} retries`;
        return jiraError(
          'E_JIRA_HTTP',
          redact(`${label} answered ${statusOf(response)}: ${why}. Try again later.`),
          { status: response.status },
        );
      }
      return answerOf(response, label, config, redact);
    }
  }

  return {
    get: (path, query) => request('GET', path, query, undefined),
    post: (path, body) => request('POST', path, undefined, body),
    put: (path, body) => request('PUT', path, undefined, body),
    async myself() {
      const answer = await request('GET', '/rest/api/3/myself', undefined, undefined);
      if (!answer.ok) return answer;
      const account = answer.value as Partial<Record<keyof JiraAccount, unknown>> | null;
      if (typeof account !== 'object' || account === null) {
        return jiraError('E_JIRA_RESPONSE', 'GET /rest/api/3/myself answered no account.');
      }
      if (typeof account.accountId !== 'string') {
        return jiraError('E_JIRA_RESPONSE', 'GET /rest/api/3/myself answered no accountId.');
      }
      return jiraOk({
        accountId: account.accountId,
        ...(typeof account.displayName === 'string' ? { displayName: account.displayName } : {}),
        ...(typeof account.emailAddress === 'string' ? { emailAddress: account.emailAddress } : {}),
      });
    },
  };
}

async function answerOf(
  response: HostFetchResponse,
  label: string,
  config: JiraConfig,
  redact: (text: string) => string,
): Promise<JiraResult<unknown>> {
  const { status } = response;
  if (status >= 300 && status < 400) {
    const location = headerOf(response, 'location');
    return jiraError(
      'E_JIRA_REDIRECT',
      redact(
        `${label} answered ${statusOf(response)}${location === undefined ? '' : ` to ${location}`}. ` +
          'A redirect is not followed: check that the site is the Jira Cloud address itself.',
      ),
      { status },
    );
  }
  if (status === 401) {
    return jiraError(
      'E_JIRA_AUTH',
      `Jira refused the API token for ${config.email} on ${config.baseUrl} (401): the token is ` +
        'wrong, expired or revoked, or belongs to another email. Create a new one at ' +
        'https://id.atlassian.com/manage-profile/security/api-tokens and store it again.',
      { status },
    );
  }
  if (status === 403) {
    return jiraError(
      'E_JIRA_AUTH',
      redact(
        `Jira refused ${config.email} on ${config.baseUrl} (403): the account may not do ` +
          `${label}, or Jira wants a CAPTCHA after failed sign-ins (sign in on the site once). ` +
          quotedBody(await bodyText(response)),
      ).trim(),
      { status },
    );
  }
  if (status < 200 || status >= 300) {
    const text = await bodyText(response);
    const body = parsedOrUndefined(text);
    return jiraError(
      'E_JIRA_HTTP',
      redact(`${label} answered ${statusOf(response)}. ${quotedBody(text)}`).trim(),
      { status, ...(body === undefined ? {} : { body }) },
    );
  }

  const text = await response.text();
  if (text.trim() === '') return jiraOk(null);
  try {
    return jiraOk(JSON.parse(text) as unknown);
  } catch {
    return jiraError(
      'E_JIRA_RESPONSE',
      `${label} answered ${status} with a body that is not JSON.`,
      {
        status,
      },
    );
  }
}

/** `https://<site>.atlassian.net/<path>?<query>`, refusing a path that would leave the site. */
function urlOf(baseUrl: string, path: string, query: JiraQuery | undefined): JiraResult<string> {
  if (!path.startsWith('/') || path.startsWith('//')) {
    return jiraError('E_JIRA_CONFIG', `'${path}' is not a path on the Jira site.`);
  }
  const url = new URL(path, baseUrl);
  if (url.origin !== baseUrl) {
    return jiraError('E_JIRA_CONFIG', `'${path}' is not a path on the Jira site.`);
  }
  for (const [name, value] of Object.entries(query ?? {})) {
    url.searchParams.set(name, String(value));
  }
  return jiraOk(url.href);
}

interface RetryWait {
  /** How long to wait, or `undefined` when Jira asked for longer than this plugin waits. */
  readonly milliseconds: number | undefined;
  readonly seconds: number;
}

/** `Retry-After` in seconds or as a date, else the backoff for this retry. */
function retryWait(response: HostFetchResponse, retry: number): RetryWait {
  const header = headerOf(response, 'retry-after');
  const fallback = BACKOFF_MILLISECONDS[Math.min(retry, BACKOFF_MILLISECONDS.length - 1)] ?? 1000;
  if (header === undefined) return { milliseconds: fallback, seconds: fallback / 1000 };
  const trimmed = header.trim();
  const seconds = /^\d+$/.test(trimmed)
    ? Number(trimmed)
    : Math.max(0, Math.ceil((Date.parse(trimmed) - Date.now()) / 1000));
  if (Number.isNaN(seconds)) return { milliseconds: fallback, seconds: fallback / 1000 };
  return {
    milliseconds: seconds <= MAX_RETRY_AFTER_SECONDS ? seconds * 1000 : undefined,
    seconds,
  };
}

function headerOf(response: HostFetchResponse, name: string): string | undefined {
  for (const [key, value] of Object.entries(response.headers)) {
    if (key.toLowerCase() === name) return value;
  }
  return undefined;
}

function statusOf(response: HostFetchResponse): string {
  return response.statusText === ''
    ? String(response.status)
    : `${response.status} ${response.statusText}`;
}

/** A failed answer's body as text, or `''` when it cannot be read. */
async function bodyText(response: HostFetchResponse): Promise<string> {
  try {
    return (await response.text()).trim();
  } catch {
    return '';
  }
}

function parsedOrUndefined(text: string): unknown {
  try {
    return text === '' ? undefined : (JSON.parse(text) as unknown);
  } catch {
    return undefined;
  }
}

/** Jira's own words for a failure, shortened: `errorMessages` and `errors` when it sent JSON. */
function quotedBody(text: string): string {
  if (text === '') return '';
  let quoted = text;
  try {
    const parsed = JSON.parse(text) as { errorMessages?: unknown; errors?: unknown };
    const messages = [
      ...(Array.isArray(parsed.errorMessages) ? parsed.errorMessages.map(String) : []),
      ...(typeof parsed.errors === 'object' && parsed.errors !== null
        ? Object.entries(parsed.errors).map(([field, message]) => `${field}: ${String(message)}`)
        : []),
    ];
    if (messages.length > 0) quoted = messages.join('; ');
  } catch {
    // Not JSON (an HTML error page, a proxy's text): quote it as it is.
  }
  const short =
    quoted.length > QUOTED_BODY_LIMIT ? `${quoted.slice(0, QUOTED_BODY_LIMIT)}…` : quoted;
  return `Jira said: ${short}`;
}

const BASE64_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';

/**
 * Standard base64 of the text's UTF-8. Written here because the plugin may use neither Node's
 * `Buffer` nor rely on `btoa`, which refuses any character above U+00FF.
 */
export function base64(text: string): string {
  const bytes = new TextEncoder().encode(text);
  let encoded = '';
  for (let index = 0; index < bytes.length; index += 3) {
    const first = bytes[index] ?? 0;
    const second = bytes[index + 1];
    const third = bytes[index + 2];
    const triple = (first << 16) | ((second ?? 0) << 8) | (third ?? 0);
    encoded += BASE64_ALPHABET[(triple >> 18) & 63];
    encoded += BASE64_ALPHABET[(triple >> 12) & 63];
    encoded += second === undefined ? '=' : BASE64_ALPHABET[(triple >> 6) & 63];
    encoded += third === undefined ? '=' : BASE64_ALPHABET[triple & 63];
  }
  return encoded;
}
