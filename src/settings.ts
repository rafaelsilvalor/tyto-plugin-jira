import type { FormConfigurationContribution } from './tyto-api.js';

/**
 * The plugin's settings, which the person writes in the desktop's `settings.json` as
 * `jira.<id>`.
 *
 * Neither is a secret. The API token is only ever the `api-token` credential (Tyto ADR 0134),
 * because a setting is plain text a person copies into a bug report. The email is the
 * `email` credential first — the CLI's `TYTO_PLUGIN_JIRA_EMAIL`, the desktop's keychain — and
 * this setting is the desktop's fallback for a person who would rather type it here. Neither
 * belongs in the shared `jira` section of `.tyto/project.json`: that file is one team's, and an
 * email is one person's.
 *
 * Read by nothing yet: the HTTP client that uses them is the next pull request.
 */
export const SETTINGS: readonly FormConfigurationContribution[] = [
  {
    id: 'baseUrl',
    form: { type: 'string', nullable: true, format: 'uri' },
    default: null,
    description:
      'The Jira Cloud site, such as https://example.atlassian.net. A workspace may name its own in the jira section of .tyto/project.json, which wins.',
  },
  {
    id: 'email',
    form: { type: 'string', nullable: true, minLength: 3 },
    default: null,
    description:
      'The email the API token belongs to, when it is not stored as the email credential.',
  },
];
