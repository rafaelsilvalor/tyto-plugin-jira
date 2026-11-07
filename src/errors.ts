/**
 * What can go wrong between this plugin and a Jira site, as data rather than as a throw.
 *
 * Tyto's own rule, held here too: an expected failure is an answer, not an exception. These
 * codes are the plugin's, not Tyto's. Tyto's diagnostic catalogue is closed and a plugin's
 * verb reports its failure as `E_RECIPE_VERB` "in its own words", so the verb that comes next
 * puts the code and the message into those words (see {@link describeJiraError}).
 */
export type JiraErrorCode =
  /** The site or a credential is missing or unusable; no request was made. */
  | 'E_JIRA_CONFIG'
  /** Jira refused the email and token (401) or the account (403). */
  | 'E_JIRA_AUTH'
  /** Jira answered a 3xx. Never followed: the next host may be one the person never allowed. */
  | 'E_JIRA_REDIRECT'
  /** Any other answer that is not a 2xx, retries included. */
  | 'E_JIRA_HTTP'
  /** The request never got an answer: Tyto refused it, or the network failed. */
  | 'E_JIRA_NETWORK'
  /** A 2xx whose body is not the JSON Jira promises. */
  | 'E_JIRA_RESPONSE';

export interface JiraError {
  readonly code: JiraErrorCode;
  readonly message: string;
  /** The HTTP status, when Jira answered. */
  readonly status?: number;
  /** The host's own refusal code (`E_PERMISSION`, `E_PLUGIN_FETCH`, `E_CREDENTIAL_MISSING`). */
  readonly hostCode?: string;
}

export type JiraResult<T> =
  { readonly ok: true; readonly value: T } | { readonly ok: false; readonly error: JiraError };

export function jiraOk<T>(value: T): JiraResult<T> {
  return { ok: true, value };
}

export function jiraError<T = never>(
  code: JiraErrorCode,
  message: string,
  details: { readonly status?: number; readonly hostCode?: string } = {},
): JiraResult<T> {
  return { ok: false, error: { code, message, ...details } };
}

/** One line for a person, the code first so a bug report carries it. */
export function describeJiraError(error: JiraError): string {
  return `${error.code}: ${error.message}`;
}

/**
 * The `code` of a refusal the host threw (`PluginCapabilityError`), or `undefined`.
 *
 * Read structurally rather than with `instanceof`: an isolated plugin's host lives in another
 * module instance, and the class identity does not survive the boundary.
 */
export function hostCodeOf(thrown: unknown): string | undefined {
  if (typeof thrown !== 'object' || thrown === null || !('code' in thrown)) return undefined;
  const code = (thrown as { readonly code: unknown }).code;
  return typeof code === 'string' ? code : undefined;
}

export function messageOf(thrown: unknown): string {
  return thrown instanceof Error ? thrown.message : String(thrown);
}
