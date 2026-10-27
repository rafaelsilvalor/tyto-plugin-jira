# tyto-plugin-jira

A [Tyto](https://github.com/rafaelsilvalor/tyto) plugin that will read Jira Cloud issues into a
recipe. Tyto knows no provider (Tyto ADR 0011, ADR 0127): everything Jira-specific lives here,
in its own repository, and reaches Tyto only through the plugin API. This repository is public
and unlicensed.

## Status

**It does nothing useful yet.** This is the scaffold: the manifest, two settings and the build.
Not yet working, each its own pull request:

- the HTTP client, the auth check against `/myself` and the reading of the workspace section;
- `jira.pull`, which pulls issues by JQL, board, keys or parent, page by page, into a table;
- `jira.refresh`;
- the user documentation and a check against a real site.

## Install into Tyto

```
tyto plugin install https://github.com/rafaelsilvalor/tyto-plugin-jira
```

Tyto copies the folder into `~/.tyto/plugins/` and never builds it, so `dist/index.js` is
committed. The install shows the permissions below and asks for your approval.

## What it may reach

| Permission              | Why                                                        |
| ----------------------- | ---------------------------------------------------------- |
| `net:*.atlassian.net`   | Jira Cloud's REST API, on any `<site>.atlassian.net`.      |
| `credentials:api-token` | The Atlassian API token, kept by Tyto and never in a file. |
| `credentials:email`     | The email the token belongs to, kept by Tyto the same way. |

**Only Jira Cloud on `atlassian.net`.** A site on a custom domain, and Jira Data Center or
Server, are out: the permission does not reach them, and widening it would mean asking every
person who installs the plugin for more than Jira Cloud needs.

## Credentials and settings

On the command line, Tyto reads the credentials from the environment:
`TYTO_PLUGIN_JIRA_API_TOKEN` and `TYTO_PLUGIN_JIRA_EMAIL`. In the desktop app they are stored
in the system keychain.

Two settings, in the desktop's `settings.json`:

- `jira.baseUrl`: the site, such as `https://example.atlassian.net`. A workspace may name its
  own in the `jira` section of `.tyto/project.json`, which wins.
- `jira.email`: the desktop's fallback for the email when it is not stored as a credential.

**The token is never a setting, and your email never goes in `.tyto/project.json`.** A setting
is plain text people paste into bug reports, and the project file is shared by a whole team.

## Development

`pnpm check` runs Prettier, the type checker, ESLint and the tests; `pnpm build` writes
`dist/index.js`, which is committed and which CI rebuilds and compares. `@tyto/plugin-api` is
not on npm, so the types this plugin uses are copied into `src/tyto-api.d.ts`, and Tyto's
manifest and setting checks into `tests/tyto-schemas.ts`, each naming the Tyto commit it came
from.
