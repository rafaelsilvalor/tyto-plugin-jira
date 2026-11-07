# tyto-plugin-jira

A [Tyto](https://github.com/rafaelsilvalor/tyto) plugin that will read Jira Cloud issues into a
recipe. Tyto knows no provider (Tyto ADR 0011, ADR 0127): everything Jira-specific lives here,
in its own repository, and reaches Tyto only through the plugin API. This repository is public
and unlicensed.

## Status

**`jira.pull` works with its fifteen fixed columns; the rest is not written yet.** A recipe
step names exactly one of `jql=`, `board=`, `keys=` or `parent=`, and `max=` (10,000 unless
written, at most 100,000):

```
jira.pull jql="project = EX AND status != Done"
```

It answers `key`, `url`, `project`, `issuetype`, `status`, `status_category`, `summary`,
`parent_key`, `assignee`, `labels`, `created`, `updated` (both ISO 8601 in UTC),
`description_urls`, `comment_urls` and `parent_description_urls`. A board is pulled by its
saved filter; a Kanban board's sub-query is not applied. More issues than `max=` is an error,
never a shorter table. Not yet working, each its own pull request:

- columns mapped from Jira fields in the `jira` section's `fields:`, and a cache of the pages;
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
`dist/index.js`, which is committed and which CI rebuilds and compares.

The plugin depends on Tyto's published contract, `@tyto/plugin-api`, which GitHub Packages
holds as `@rafaelsilvalor/tyto-plugin-api` (Tyto ADR 0149); `package.json` aliases it, so the
code imports `@tyto/plugin-api`. Installing it needs a GitHub token with `read:packages`, and
pnpm reads that token only from your user-level `~/.npmrc`, never from the committed one:

```sh
gh auth refresh -s read:packages
echo '//npm.pkg.github.com/:_authToken=${NODE_AUTH_TOKEN}' >> ~/.npmrc
NODE_AUTH_TOKEN=$(gh auth token) pnpm install
```

The plugin imports only types from it, so the bundle does not change. The tests run the committed `dist/index.js` through the contract's own
harness, `@tyto/plugin-api/testing` (Tyto ADR 0150): build before you test.

The `contract` workflow runs every Monday, and on demand, against the newest published
contract rather than the range in `package.json`: a red run there is a Tyto release this plugin
does not yet work with.
