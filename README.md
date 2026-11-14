# tyto-plugin-jira

A [Tyto](https://github.com/rafaelsilvalor/tyto) plugin that reads Jira Cloud issues into a
recipe. Tyto knows no provider (Tyto ADR 0011, ADR 0127): everything Jira-specific lives here,
in its own repository, and reaches Tyto only through the plugin API. This repository is public
and unlicensed.

It adds seven recipe verbs:

- **`jira.pull`**, a source: the issues a JQL query, a board, a list of keys or a parent names,
  as a table.
- **`jira.refresh`**, a transform: the table it is handed, with each row that names an issue
  filled with what Jira holds now.
- **`jira.transition`**, **`jira.assign`**, **`jira.set`** and **`jira.comment`**, actions: they
  move each row's issue to a status, assign it to an account, set one of its fields, or comment
  on it.
- **`jira.create`**, an action: it creates one issue per row.

**Running an action writes nothing.** Its cell shows a plan, one line per row, and Jira
changes only when you apply it (Tyto ADR 0129, ADR 0170).

Every example below is invented: `example.atlassian.net`, project `EX`, issues `EX-1`, `EX-2`.

## Install

From the gallery, when the gallery you read lists it: **Gallery: Browse Templates and
Plugins**, then **Install** on its card, or `tyto gallery install <id>` in a terminal. Or
straight from this repository:

```
tyto plugin install git+https://github.com/rafaelsilvalor/tyto-plugin-jira.git
```

Tyto copies the folder and never builds it, so `dist/index.js` is committed. Either way, the
install shows the permissions below and asks for your approval.

### What it may reach

| Permission              | Why                                                        |
| ----------------------- | ---------------------------------------------------------- |
| `net:*.atlassian.net`   | Jira Cloud's REST API, on any `<site>.atlassian.net`.      |
| `credentials:api-token` | The Atlassian API token, kept by Tyto and never in a file. |
| `credentials:email`     | The email the token belongs to, kept by Tyto the same way. |

**Only Jira Cloud on `atlassian.net`.** A site on a custom domain, and Jira Data Center or
Server, are out: the permission does not reach them, and widening it would mean asking every
person who installs the plugin for more than Jira Cloud needs.

## Credentials

The plugin signs in with an Atlassian API token and the email of the account it belongs to.
Create the token at <https://id.atlassian.com/manage-profile/security/api-tokens>. The plugin
reads with that account's permissions, so it sees exactly the issues the account sees.

| Where        | API token                                    | Email                                                  |
| ------------ | -------------------------------------------- | ------------------------------------------------------ |
| Command line | `TYTO_PLUGIN_JIRA_API_TOKEN`                 | `TYTO_PLUGIN_JIRA_EMAIL`                               |
| Desktop app  | the system keychain, from the plugins screen | the keychain the same way, or the `jira.email` setting |

On the command line a credential is an environment variable and nothing else. In the desktop
app it is stored from the plugins screen, beside the plugin, and never written to a file.

Two settings, in the desktop's `settings.json`:

- `jira.baseUrl`: the site, such as `https://example.atlassian.net`. A workspace may name its
  own in the `jira` section of `.tyto/project.json`, which wins.
- `jira.email`: the email, used only when no `email` credential is stored.

Every request carries `X-Atlassian-Token: no-check`, Atlassian's header for REST clients: the
desktop app sends requests with a browser's User-Agent, and Jira Cloud refuses such a POST with
"XSRF check failed" without it. It also names itself with `User-Agent: tyto-plugin-jira/<version>`,
because the opt-out header is not enough on its own: measured against a Jira Cloud site on
2026-11-08, the same POST with that header answered 403 with Electron's default User-Agent and
200 with the plugin's own.

**The token is never a setting, and your email never goes in `.tyto/project.json`.** A setting
is plain text people paste into bug reports, and the project file is shared by a whole team.

## The `jira` section of `.tyto/project.json`

A workspace says which site it works with, and which extra fields become columns:

```json
{
  "jira": {
    "baseUrl": "https://example.atlassian.net",
    "fields": { "story_points": "customfield_10016", "team": "customfield_10020" }
  }
}
```

- `baseUrl`: the site, `https://<site>.atlassian.net`, with no path. It wins over the
  `jira.baseUrl` setting.
- `fields`: a column name for each Jira field id. See [Mapped fields](#mapped-fields).

- `workflows`: the transition graphs `jira.transition` walks, by name. Each maps a status to
  the statuses one transition reaches from it:

```json
{
  "jira": {
    "workflows": {
      "delivery": {
        "To Do": ["In Progress"],
        "In Progress": ["Review"],
        "Review": ["Done", "In Progress"]
      }
    }
  }
}
```

A team's own graph belongs in its workspace, never in this plugin.

## `jira.pull`

A source: it starts a recipe, and names exactly one of four selectors.

```
jira.pull jql="project = EX AND status != Done"
jira.pull board=12
jira.pull keys="EX-1,EX-2,EX-7"
jira.pull parent=EX-1
```

| Argument  | What it reads                                                               |
| --------- | --------------------------------------------------------------------------- |
| `jql=`    | the issues a JQL query answers, in its order                                |
| `board=`  | a board, by its number, through its saved filter                            |
| `keys=`   | the issues of a comma-separated list of keys                                |
| `parent=` | the children of one issue                                                   |
| `max=`    | the most issues the step may answer: 10,000 unless written, at most 100,000 |

A board is pulled by its saved filter; a Kanban board's sub-query (the rule that hides old
done issues from the board) is not applied. **More issues than `max=` is an error, never a
shorter table.**

### The fifteen columns

Every pull answers these columns, in this order:

| Column                    | Type       | Value                                                 |
| ------------------------- | ---------- | ----------------------------------------------------- |
| `key`                     | `text`     | the issue key, `EX-1`; also the row's key             |
| `url`                     | `link`     | `https://example.atlassian.net/browse/EX-1`           |
| `project`                 | `text`     | the project key, `EX`                                 |
| `issuetype`               | `text`     | `Task`, `Story`, `Epic`…                              |
| `status`                  | `text`     | the status name                                       |
| `status_category`         | `text`     | `To Do`, `In Progress` or `Done`                      |
| `summary`                 | `text`     | the summary                                           |
| `parent_key`              | `text`     | the parent's key, or empty                            |
| `assignee`                | `text`     | the assignee's display name, or empty                 |
| `labels`                  | `list`     | the labels                                            |
| `created`                 | `datetime` | ISO 8601 in UTC                                       |
| `updated`                 | `datetime` | ISO 8601 in UTC                                       |
| `description_urls`        | `list`     | every link in the description, first occurrence first |
| `comment_urls`            | `list`     | every link in every comment                           |
| `parent_description_urls` | `list`     | every link in the parent's description                |

Each row's provenance is `{source: "jira", id: <the issue's id>, fetchedAt}`.

### Mapped fields

Any other Jira field becomes a column, after the fixed ones, when the `fields` of the `jira`
section maps a column name to the field's id. A column name is lower case letters, digits and
`_`, starting with a letter, and is not one of the fifteen fixed columns. The id must be one the
site has: the first page of a pull reads the site's field catalogue (`GET /rest/api/3/field`),
and a name written where the id belongs is refused with the id it should have been. The
catalogue's `schema.type` gives the column's type:

| Jira type                               | Column     | Value                                       |
| --------------------------------------- | ---------- | ------------------------------------------- |
| `string`                                | `text`     | the text; a rich-text field's plain text    |
| `number`                                | `number`   | the number                                  |
| `date`                                  | `date`     | `2026-10-01`                                |
| `datetime`                              | `datetime` | ISO 8601 in UTC                             |
| `array`                                 | `list`     | each item as text, an empty list when unset |
| `option`, `user`, `priority` and others | `text`     | its `value`, `name` or `displayName`        |

A section edited between two pages of one pull is refused rather than stitched together.

## `jira.refresh`

A transform: it takes the table the steps before it made, and fills each row that names an
issue with what Jira holds now, in the same columns `jira.pull` answers.

```
jira.refresh [by=<column>] [only=<boolean column>] [children=true] [prefix=<text>]
```

| Argument        | What it does                                                                       |
| --------------- | ---------------------------------------------------------------------------------- |
| `by=`           | reads the issue key from this text column instead of the row's key                 |
| `only=`         | refreshes only the rows where this boolean column is true, such as `recall`'s mark |
| `children=true` | adds every child of the refreshed issues, so `rollup` sees them all                |
| `prefix=`       | writes every Jira column under this prefix, such as `jira_status` for `jira_`      |

- **Without `prefix=`, a column of the same name is overwritten**: a sheet's own `status`
  column takes Jira's status. With `prefix=jira_`, the step writes `jira_key`, `jira_status`,
  `jira_summary` and so on, and the sheet's `status` keeps the person's value, so a later step
  (Tyto's `decide`) can compare the two. A prefix is letters, digits and underscores, a letter
  first.
- Every row keeps its row key, also when `by=` reads the issue key from another column, so
  the steps after it (`decide`, `remember`, `jira.transition`) and the state Apply commits
  match the same row.
- A column the table lacks is added; a column of the same name and another type is refused,
  so rename it before the step. Columns of your own, and rows `only=` leaves out, pass through
  unchanged.
- **A deleted issue keeps its row**, with its Jira columns empty, so a recipe can see it went.
  A moved issue (another project, another key) keeps its row key, and its `key` and `url`
  columns show where it is now.
- A child already in the table is updated in place; a new one is added. Every refreshed row's
  provenance is `{source: "jira.refresh", id: <key>, fetchedAt}`.
- It always reads Jira; it uses no cache.

## `jira.transition`

An action: it moves each row's issue from the status in the table's `status` column to a
target status.

```
jira.transition (to=<status> | to-column=<column>) [workflow=<name> | workflow-column=<column>]
                [from-column=<column>]
```

| Argument           | What it does                                                                   |
| ------------------ | ------------------------------------------------------------------------------ |
| `to=`              | one target status for every row                                                |
| `to-column=`       | reads each row's target from this text column; **an empty cell plans nothing** |
| `workflow=`        | walks every row through this workflow of the `workflows` key                   |
| `workflow-column=` | reads each row's workflow from this text column; an empty cell is one step     |
| `from-column=`     | reads where each issue stands from this column instead of `status`             |

- `to=` and `to-column=` are refused together, and so are `workflow=` and `workflow-column=`.
- With a workflow, it walks the shortest path through it, one transition per status. Without
  one, it takes one direct transition.
- `to-column=` is how a recipe moves only the rows a step before it chose: Tyto's `decide`
  writes `<column>_push`, empty on the rows with nothing to push. A workflow a row names and
  the `workflows` key lacks fails that row alone.
- After `jira.refresh prefix=jira_`, `from-column=jira_status` reads Jira's status rather
  than the sheet's own `status` column.
- The plan reads nothing from Jira. A status the workflow cannot reach from the row's is a
  failure planned for that row alone, naming the statuses the workflow does reach; the other
  rows still plan and apply. A row already at its target is left out of the plan.
- At each step, Apply asks the issue which transitions it offers and takes the one that leads to
  the next status (ignoring case). None, or more than one, fails the issue and names them.
- Apply reads each issue first. **An issue that moved since the plan fails alone**; one already
  at its target is applied with nothing written; one standing on its planned path resumes from there.

## `jira.assign`

An action: it assigns each row's issue.

```
jira.assign to=<column>|me|none
```

- `to=<column>` takes the account id in that text column, `me` the token's own account, `none`
  leaves the issue unassigned. There is no lookup by name or email: a cell that is not an
  account id is a planned failure.
- When the table holds `jira.pull`'s `assignee` column, Apply checks the issue is still assigned
  to that person, and fails an issue reassigned since the plan.

## `jira.set`

An action: it sets one field of each row's issue to the row's cell.

```
jira.set field=<field> value=<column> [only=<column>] [from-column=<column>]
```

- `field=` is a column the `fields` of the `jira` section maps, or one of `summary`, `labels`,
  `duedate` and `priority`. Anything else is refused before a plan.
- The cell is written as the field's type takes it, read off the site's field catalogue:

  | Field type                     | Cell                  | Written                                    |
  | ------------------------------ | --------------------- | ------------------------------------------ |
  | text (`summary` too)           | any text              | the text                                   |
  | paragraph (a `textarea` field) | any text              | a document: paragraphs, line breaks, links |
  | `number`                       | a number, or its text | the number                                 |
  | `date` (`duedate` too)         | `2026-12-01`          | the date                                   |
  | `option`                       | the option's value    | `{"value": …}`                             |
  | `user`                         | an account id         | `{"accountId": …}`                         |
  | `priority`                     | the priority's name   | `{"name": …}`                              |
  | list of text (`labels`)        | a list, or words      | each word, split on blanks and commas      |
  | list of options                | a list, or `a, b`     | `[{"value": …}]`                           |

  Any other type is refused. An empty cell clears the field, except `summary` and `priority`,
  where it is a planned failure of its row, as is a cell the type cannot take.

- **The plan reads only the field catalogue**, and only for a mapped field; it is kept in the
  plugin's cache for ten minutes, so planning again asks Jira nothing.
- When the table holds a column named like `field=` (as `jira.pull` answers `summary` and
  `labels`, or a mapped column), Apply checks Jira still holds what that column read, and fails
  an issue whose field changed since the plan. An issue that already holds the value is applied
  with nothing written.
- **`only=` plans nothing for the rows it leaves out**: it keeps a row whose cell in that column
  is true (a boolean column) or holds something (any other column), as `jira.refresh` keeps
  its rows. The rows it keeps plan as without it: an empty value cell still clears the field,
  and a cell the field cannot take still fails that row alone.
- `from-column=` names the column the drift check reads instead of the one named like
  `field=`: after `jira.refresh prefix=jira_`, the column named like the field is the sheet's
  own, and Jira's is `jira_<field>`.
- `only=` and `from-column=` naming a column the table lacks are refused before a plan.
- `only=` is how a recipe writes a shared field back only on the rows a step before it chose.
  Tyto's `decide` writes `<column>_push`, the value to write, and `<column>_pushes`, true
  exactly on a push row. With `{"team": "customfield_10020"}` in the `fields` of the `jira`
  section:

  ```
  google.sheet-rows tab=Tasks
  jira.refresh by=key prefix=jira_
  last sync columns=team
  decide team local=team remote=jira_team last=last_team hold-when-empty=jira_status clear=push
  remember sync columns=team when="team_action != hold"
  jira.set field=team value=team_push only=team_pushes from-column=jira_team
  select key team
  google.sheet-sync key=key tab=Tasks
  ```

  `clear=push` makes a cell emptied in the sheet since the last applied run a push of the
  empty value, so `team_push` is empty on that row while `team_pushes` is true, and the step
  clears the field in Jira; a cell never filled pushes nothing. That is why `only=` reads
  `team_pushes`, not `team_push`. A status flow keeps `decide` without `clear=` and
  `jira.transition to-column=status_push`, so a status cell emptied by mistake never clears
  anything.

  The write comes before `select` and the sync, because each step reads only the table the
  step before it answered.

## `jira.comment`

An action: it adds each row's text as a comment on its issue.

```
jira.comment body=<column>
```

- The text becomes a document: a blank line starts a paragraph, a line break stays one, and
  every `http(s)://` address is a link. Nothing else is read as markup.
- An empty cell, or a text over 1,500 bytes, is a planned failure of its row.
- **Applying twice comments once.** Before posting, Apply reads the issue's last 50 comments;
  one this account left with the same text is applied with nothing written.

## `jira.create`

An action: it creates one issue per row, in one project, of one issue type.

```
jira.create project=<key> type=<issue type> summary=<column> [description=<column>] [parent=<column>]
```

- `summary=` is the column of each issue's summary; an empty one, or one over 255 characters,
  is a planned failure of its row. `description=` becomes a document as `jira.comment`'s text
  does, up to 1,500 bytes. `parent=` holds the parent's issue key, such as `EX-1`.
- Every other column of the table that the `fields` of the `jira` section maps is written too,
  converted as `jira.set` converts it; an empty cell leaves the field out. A mapped column of a
  type it cannot write refuses the step: drop the column before it. The plan reads only the
  field catalogue, and only when the table holds a mapped column.
- A row whose summary, description and mapped values need more than 2,048 bytes to be kept
  with the plan is a planned failure of its row.
- Apply creates up to 50 issues per request (`POST /rest/api/3/issue/bulk`). Each row answers
  the key of the issue it created (`created EX-42`), or Jira's own words for why that one was
  refused; the others are created.

**Each issue keeps a label, `tyto-<16 hex digits>`, on purpose.** It is a fingerprint of the
site, the project and the row's key, so the same row always makes the same label. Before
creating, Apply searches for the labels of its batch, and a row whose label is found answers
`already created EX-42` with nothing written: an Apply whose answer was lost, or one run twice,
creates each issue once. Removing the label from an issue gives up that guard for its row.

Jira's search index can lag a write by a few seconds. **Applying again right after a create
may not find the label yet**, and create the issue a second time; wait a little before
applying the same plan again.

## Applying a plan

Tyto hands a plan back in batches of 100 operations. Each batch reads its issues in one search
(`key in (...)`; `labels in (...)` for `jira.create`) and writes them in order for up to 20 s;
**the operations past that are skipped**, and applying again after running the cell picks them
up. After Jira refuses the
token, the rest of the batch fails with the same reason, asking nothing more. A failed
operation's reason starts with the plugin's code, as below.

## A worked recipe: what left the query

A recipe that lists the issues waiting on review, and also the ones that were waiting at the
last applied run and have moved on since, with their status now:

```
recipe review-queue
  | Issues waiting on review, and those that left the queue since the last run.

jira.pull jql="project = EX AND labels = review"
recall review mark=recalled
jira.refresh only=recalled children=true
rollup open_children parent=parent_key when="status_category != Done"
remember review columns=status
show table
```

1. `jira.pull` brings the issues the query answers now.
2. `recall review mark=recalled` appends a row for every key the `review` store holds that the
   table lacks (an issue that left the query), and marks those rows in a `recalled` column.
3. `jira.refresh only=recalled children=true` reads those issues from Jira, so a recalled row
   shows its current status instead of nothing, and adds their children.
4. `rollup` counts, on each parent, the children that are not done.
5. `remember review columns=status` stores the rows when the run is applied, for the next
   run's `recall`.

## The page cache

Each page of a `jira.pull` keeps Jira's raw answers (the search, the comment pages and the
parents) in the plugin's private cache in Tyto, never in the workspace, so running a recipe
again **within ten minutes** asks Jira nothing; a board's filter and the field catalogue are
still read. An entry is used only for the same site, account, query, fields and page, and only
when the first page of the run came from the same fill, so one table never mixes two reads of
Jira. Rows from the cache carry the time the page was stored as their `fetchedAt`.

To read Jira now, run the recipe fetching again (**Run recipe, fetching again** in the
desktop): the pull skips the cache and refills it. `jira.refresh` never uses the cache. **The
cache never fails a pull:** when Tyto cannot read or store an entry, the plugin logs a warning
and reads Jira.

## Limits

| Limit                          | Value                                                       |
| ------------------------------ | ----------------------------------------------------------- |
| Issues per `jira.pull` step    | `max=`, 10,000 unless written, at most 100,000              |
| Issues per search page         | 50; the host asks for each page in its own call             |
| Issues per `jira.refresh` step | 1,000                                                       |
| Children per `jira.refresh`    | 5,000                                                       |
| Time per `jira.refresh` step   | 25 s, under the host's 30 s for one call                    |
| Retries on 429 and 503         | 3, waiting 1, 2 and 4 s, or Jira's `Retry-After` up to 30 s |
| Cache entry                    | 32 MiB; a larger page is read live and not stored           |
| Writes per apply call          | 100 operations, written for up to 20 s                      |
| Kept per planned operation     | 2,048 bytes; a longer walk is a planned failure of its row  |
| Comment per row                | 1,500 bytes of text; a longer one is a planned failure      |
| Comments read before posting   | the issue's last 50                                         |
| Issues per create request      | 50                                                          |
| Summary of a created issue     | 255 characters; a longer one is a planned failure           |
| Description of a created issue | 1,500 bytes of text; a longer one is a planned failure      |

**Past a limit, a step is an error, never a partial table.** A refresh past its ceilings says
so and asks you to narrow it with `only=`.

## Errors

A failure reaches the recipe as Tyto's `E_RECIPE_VERB`, its message starting with the verb and
the plugin's own code, such as `'jira.pull' failed: E_JIRA_AUTH: …`. Arguments that do not say
what to read, or name a column the table lacks, are `E_RECIPE_ARGUMENTS`.

| Code                | What happened                                                                                                             | What to do                                                                                                       |
| ------------------- | ------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------- |
| `E_JIRA_CONFIG`     | No site, token or email; a site that is not Jira Cloud; a `fields` entry the site does not have.                          | Set what the message names: the site, the credential, or the field id it suggests.                               |
| `E_JIRA_AUTH`       | Jira refused the token (401) or the account (403).                                                                        | 401: create a token and store it again. 403: check the account may see the project, or sign in on the site once. |
| `E_JIRA_REDIRECT`   | Jira answered a redirect, which is never followed.                                                                        | Check the site is the Jira Cloud address itself.                                                                 |
| `E_JIRA_HTTP`       | Any other failed answer, a 429 or 503 still failing after its retries included.                                           | Read Jira's own words in the message, such as a JQL mistake. Try a 429 or 503 again later.                       |
| `E_JIRA_NETWORK`    | No answer: Tyto refused the request, or the network failed.                                                               | Check the connection. A refusal by Tyto names its own code, such as `E_PERMISSION`.                              |
| `E_JIRA_RESPONSE`   | Jira answered something that is not what its API promises.                                                                | Run again; if it stays, report it with the message.                                                              |
| `E_JIRA_PLAN`       | A planned write that cannot be applied: no issue key, status, account id or text; a cell its field cannot take; too long. | Fix the row the reason names, run the cell, apply again.                                                         |
| `E_JIRA_MOVED`      | The issue changed between the plan and Apply, or is gone.                                                                 | Run the cell again for a plan from where the issue stands now.                                                   |
| `E_JIRA_TRANSITION` | The issue offers no transition to the next status, or more than one.                                                      | Check the workflow in the section against the transitions the reason names.                                      |

No message carries the API token, even when Jira echoes it.

## Checking against a real site

`tests/live.test.ts` runs the reading verbs against a real Jira Cloud site, and only when
three environment variables name one. Without them it is skipped, which is what CI does:

```sh
JIRA_LIVE_BASE_URL=https://<site>.atlassian.net \
JIRA_LIVE_EMAIL=<email> \
JIRA_LIVE_TOKEN=<api-token> \
JIRA_LIVE_JQL='project = <KEY> ORDER BY updated DESC' \
pnpm test:live
```

`JIRA_LIVE_JQL` is optional, `updated >= -7d ORDER BY updated DESC` when unset. The check signs
in through `/rest/api/3/myself`, takes the first 20 issues the query answers, pulls them with
`jira.pull jql="key in (...)"`, and refreshes three of them with `jira.refresh`. It asserts the
shape of the answers (the columns, their types, non-empty keys, the provenance), never a value,
and prints only counts. `pnpm test:live` builds first, because the verbs run from
`dist/index.js`.

**The writes run only when a fourth variable names a sandbox project**, one where a test issue
may be created and left behind:

```sh
JIRA_LIVE_BASE_URL=https://<site>.atlassian.net \
JIRA_LIVE_EMAIL=<email> \
JIRA_LIVE_TOKEN=<api-token> \
JIRA_LIVE_SANDBOX_PROJECT=<KEY> \
JIRA_LIVE_SANDBOX_TYPE='<issue type>' \
pnpm test:live
```

`JIRA_LIVE_SANDBOX_TYPE` is optional, `Task` when unset. The check creates one issue in that
project with `jira.create`, waits up to 30 s for the search to find its label, prints how long
that took, and applies the same plan again, which must create nothing. Then, on that issue
alone, it sets the summary with `jira.set`, comments twice with `jira.comment` (the second
writes nothing), assigns it to the token's account with `jira.assign to=me`, and takes one of
the transitions it offers with `jira.transition`. Nothing else on the site is written; the
issue stays in the project, labelled, for you to delete.

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

The plugin imports only types from it, so the bundle does not change. The tests run the
committed `dist/index.js` through the contract's own harness, `@tyto/plugin-api/testing` (Tyto
ADR 0150): build before you test.

The `contract` workflow runs every Monday, and on demand, against the newest published
contract rather than the range in `package.json`: a red run there is a Tyto release this plugin
does not yet work with.
