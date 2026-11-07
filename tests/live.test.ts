import { readFileSync } from 'node:fs';

import type { FetchedResponse, HostFetchInit, HostFetchResponse } from '@tyto/plugin-api';
import { testPlugin, type PluginHarness } from '@tyto/plugin-api/testing';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { FIXED_COLUMNS } from '../src/columns.js';
import { createJiraClient, type JiraClient } from '../src/http.js';
import { searchPage } from '../src/search.js';

/**
 * The verbs against a real Jira Cloud site, run only when the environment names one:
 *
 *   JIRA_LIVE_BASE_URL=https://<site>.atlassian.net JIRA_LIVE_EMAIL=<email> \
 *   JIRA_LIVE_TOKEN=<api-token> [JIRA_LIVE_JQL='<query>'] \
 *   [JIRA_LIVE_SANDBOX_PROJECT=<KEY> [JIRA_LIVE_SANDBOX_TYPE=<issue type>]] pnpm test:live
 *
 * Without the three variables the suite is skipped, which is what CI does. It asserts shapes
 * only — column names and types, non-empty keys, provenance — never a value, takes no
 * snapshot, and prints counts alone: a real site's issues and the token never reach a log.
 *
 * The writes run only when JIRA_LIVE_SANDBOX_PROJECT also names a project, and only on one
 * issue they create there: the issue is left behind, and nothing else on the site is written.
 */
const BASE_URL = process.env['JIRA_LIVE_BASE_URL'];
const EMAIL = process.env['JIRA_LIVE_EMAIL'];
const TOKEN = process.env['JIRA_LIVE_TOKEN'];
const JQL = process.env['JIRA_LIVE_JQL']?.trim() || 'updated >= -7d ORDER BY updated DESC';
const SANDBOX = process.env['JIRA_LIVE_SANDBOX_PROJECT']?.trim();
const SANDBOX_TYPE = process.env['JIRA_LIVE_SANDBOX_TYPE']?.trim() || 'Task';
/** How long the check waits for the search to find a new issue's label. */
const INDEX_WAIT_MILLISECONDS = 30_000;

/** At most this many issues are pulled, so the check stays one page and one call. */
const PULLED = 20;
const REFRESHED = 3;
const TIMEOUT_MILLISECONDS = 60_000;

const ISO_UTC = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;
const ISSUE_KEY = /^[A-Z][A-Z0-9_]+-\d+$/;
const FIXED = FIXED_COLUMNS.map((column) => `${column.name}:${column.type}`);

const manifest = readFileSync(new URL('../tyto-plugin.json', import.meta.url), 'utf8');
const entry = new URL('../dist/index.js', import.meta.url).href;

/** Node's own fetch as the host's port: whole bodies, and a redirect handed back, never followed. */
async function realFetch(url: string, init: HostFetchInit = {}): Promise<FetchedResponse> {
  const answer = await fetch(url, {
    method: init.method ?? 'GET',
    redirect: 'manual',
    ...(init.headers === undefined ? {} : { headers: { ...init.headers } }),
    ...(init.body === undefined ? {} : { body: init.body }),
  });
  return {
    url: answer.url,
    status: answer.status,
    statusText: answer.statusText,
    headers: Object.fromEntries(answer.headers),
    body: new Uint8Array(await answer.arrayBuffer()),
  };
}

async function clientFetch(url: string, init?: HostFetchInit): Promise<HostFetchResponse> {
  const fetched = await realFetch(url, init);
  const text = new TextDecoder().decode(fetched.body);
  return {
    ...fetched,
    ok: fetched.status >= 200 && fetched.status < 300,
    text: async () => text,
    json: async () => JSON.parse(text) as unknown,
  };
}

/** A failure's text with the secrets taken out, so a red run can be pasted into a report. */
function redacted(text: string): string {
  return [TOKEN, EMAIL].reduce<string>(
    (current, secret) =>
      secret === undefined || secret === '' ? current : current.split(secret).join('[redacted]'),
    text,
  );
}

function report(line: string): void {
  process.stdout.write(`live: ${line}\n`);
}

const SKIPPED = !BASE_URL || !EMAIL || !TOKEN;
// Said by name, so a run without the variables (CI's) shows the check was skipped, not lost.
if (SKIPPED)
  report('skipped: JIRA_LIVE_BASE_URL, JIRA_LIVE_EMAIL and JIRA_LIVE_TOKEN are not all set');

describe.skipIf(SKIPPED)('against a real Jira Cloud site', () => {
  let client: JiraClient;
  let plugin: PluginHarness | undefined;
  let keys: string[] = [];

  beforeAll(async () => {
    client = createJiraClient({
      fetch: clientFetch,
      config: { baseUrl: BASE_URL ?? '', email: EMAIL ?? '', token: TOKEN ?? '' },
    });
    const loaded = await testPlugin({
      manifest,
      load: () => import(entry),
      settings: { 'jira.baseUrl': BASE_URL },
      secrets: { 'api-token': TOKEN ?? '', email: EMAIL ?? '' },
      fetch: realFetch,
    });
    if (!loaded.ok) {
      throw new Error(redacted(loaded.error.map((item) => item.code).join(', ')));
    }
    plugin = loaded.value;
  }, TIMEOUT_MILLISECONDS);

  afterAll(async () => {
    await plugin?.close();
  });

  /** The last cell of a recipe, or a failure naming its codes and redacted messages. */
  async function lastCell(source: string, options: Parameters<PluginHarness['runRecipe']>[1]) {
    if (plugin === undefined) throw new Error('the plugin did not load');
    const ran = await plugin.runRecipe(source, options);
    if (!ran.ok) throw new Error(redacted(ran.error.map((item) => item.code).join(', ')));
    const cell = ran.value.cells.at(-1);
    const errors = (cell?.diagnostics ?? []).filter((item) => item.severity === 'error');
    if (errors.length > 0) {
      throw new Error(redacted(errors.map((item) => `${item.code}: ${item.message}`).join('\n')));
    }
    if (cell?.table === undefined) throw new Error('the recipe answered no table');
    return cell.table;
  }

  it(
    'signs in through /myself',
    async () => {
      const account = await client.myself();
      if (!account.ok) throw new Error(redacted(`${account.error.code}: ${account.error.message}`));
      expect(typeof account.value.accountId).toBe('string');
      expect(account.value.accountId.length).toBeGreaterThan(0);
    },
    TIMEOUT_MILLISECONDS,
  );

  it(
    'pulls the first issues of the query with jira.pull',
    async () => {
      const page = await searchPage(client, JQL, ['status'], undefined);
      if (!page.ok) throw new Error(redacted(`${page.error.code}: ${page.error.message}`));
      keys = page.value.issues.slice(0, PULLED).map((issue) => issue.key);
      report(`the query answered ${keys.length} of at most ${PULLED} issues`);
      expect(keys.length, 'JIRA_LIVE_JQL answered no issue; widen it').toBeGreaterThan(0);

      const table = await lastCell(
        `jira.pull jql="key in (${keys.join(', ')}) ORDER BY key ASC" max=${PULLED}`,
        {},
      );
      report(`jira.pull answered ${table.rows.length} rows and ${table.columns.length} columns`);
      expect(table.columns.map((column) => `${column.name}:${column.type}`)).toEqual(FIXED);
      expect(table.rows.length).toBe(keys.length);
      for (const row of table.rows) {
        expect(row.key).toMatch(ISSUE_KEY);
        expect(row.values['key']).toBe(row.key);
        expect(typeof row.values['url']).toBe('string');
        expect(Array.isArray(row.values['labels'])).toBe(true);
        expect(row.values['created']).toMatch(ISO_UTC);
        expect(row.provenance.source).toBe('jira');
        expect(row.provenance.id).toMatch(/^\d+$/);
        expect(row.provenance.fetchedAt).toMatch(ISO_UTC);
      }
    },
    TIMEOUT_MILLISECONDS,
  );

  it(
    'refreshes three of them with jira.refresh',
    async () => {
      const chosen = keys.slice(0, REFRESHED);
      expect(chosen.length, 'the pull found no issue to refresh').toBeGreaterThan(0);
      const table = await lastCell('jira.refresh', {
        input: {
          columns: [{ name: 'key', type: 'text', origin: 'live' }],
          rows: chosen.map((key) => ({
            key,
            values: { key },
            provenance: { source: 'live', id: key, fetchedAt: new Date().toISOString() },
          })),
        },
      });
      report(`jira.refresh answered ${table.rows.length} of ${chosen.length} rows`);
      expect(table.columns.map((column) => `${column.name}:${column.type}`)).toEqual(FIXED);
      expect(table.rows.map((row) => row.key)).toEqual(chosen);
      for (const row of table.rows) {
        expect(row.values['key']).toMatch(ISSUE_KEY);
        expect(row.values['updated']).toMatch(ISO_UTC);
        expect(row.provenance.source).toBe('jira.refresh');
        expect(row.provenance.id).toMatch(ISSUE_KEY);
        expect(row.provenance.fetchedAt).toMatch(ISO_UTC);
      }
    },
    TIMEOUT_MILLISECONDS,
  );
});

const WRITES_SKIPPED = SKIPPED || !SANDBOX;
if (!SKIPPED && WRITES_SKIPPED) report('writes skipped: JIRA_LIVE_SANDBOX_PROJECT is not set');

describe.skipIf(WRITES_SKIPPED)('writing to the sandbox project of a real site', () => {
  const project = SANDBOX ?? '';
  let client: JiraClient;
  let plugin: PluginHarness | undefined;
  /** The one issue the writes touch: the one `jira.create` made in the sandbox project. */
  let created: string | undefined;

  beforeAll(async () => {
    client = createJiraClient({
      fetch: clientFetch,
      config: { baseUrl: BASE_URL ?? '', email: EMAIL ?? '', token: TOKEN ?? '' },
    });
    const loaded = await testPlugin({
      manifest,
      load: () => import(entry),
      settings: { 'jira.baseUrl': BASE_URL },
      secrets: { 'api-token': TOKEN ?? '', email: EMAIL ?? '' },
      fetch: realFetch,
    });
    if (!loaded.ok) {
      throw new Error(redacted(loaded.error.map((item) => item.code).join(', ')));
    }
    plugin = loaded.value;
  }, TIMEOUT_MILLISECONDS);

  afterAll(async () => {
    await plugin?.close();
  });

  /** The sandbox issue, refusing to go on when it is not one of the sandbox project. */
  function sandboxIssue(): string {
    if (created === undefined || !created.startsWith(`${project}-`)) {
      throw new Error('no issue of the sandbox project was created; nothing else is written');
    }
    return created;
  }

  /** Plans the step over the rows, and answers the plan and a function that applies it. */
  async function planned(
    step: string,
    columns: readonly string[],
    rows: readonly Readonly<Record<string, string | null>>[],
  ) {
    if (plugin === undefined) throw new Error('the plugin did not load');
    const ran = await plugin.runRecipe(step, {
      input: {
        columns: columns.map((name) => ({ name, type: 'text', origin: 'live' })),
        rows: rows.map((values, index) => ({
          key: values['key'] ?? `live-${index}`,
          values,
          provenance: { source: 'live', id: String(index), fetchedAt: new Date().toISOString() },
        })),
      },
    });
    if (!ran.ok) throw new Error(redacted(ran.error.map((item) => item.code).join(', ')));
    const cell = ran.value.cells.at(-1);
    const errors = (cell?.diagnostics ?? []).filter((item) => item.severity === 'error');
    const plan = cell?.plan;
    if (errors.length > 0 || plan === undefined) {
      throw new Error(redacted(errors.map((item) => `${item.code}: ${item.message}`).join('\n')));
    }
    const apply = async () => {
      const verb = plugin?.recipes.verbs.get(step.split(' ')[0] ?? '');
      if (verb?.apply === undefined) throw new Error(`${step} has no apply`);
      const applied = await verb.apply(plan);
      if (!applied.ok) throw new Error(redacted(applied.error.map((item) => item.code).join(', ')));
      return applied.value.operations.map(({ status, reason }) => ({
        status,
        reason: redacted(reason ?? ''),
      }));
    };
    return { plan, apply };
  }

  it(
    'creates one issue with jira.create, and once its label is found, applying again creates none',
    async () => {
      const { plan, apply } = await planned(
        `jira.create project=${project} type="${SANDBOX_TYPE}" summary=title`,
        ['key', 'title'],
        [{ key: `live-${Date.now()}`, title: 'Tyto live check: safe to delete' }],
      );
      const [first] = await apply();
      expect(first?.status, first?.reason).toBe('applied');
      created = /^created (\S+)$/.exec(first?.reason ?? '')?.[1];
      const key = sandboxIssue();
      report(`jira.create created one issue in ${project}`);

      const label = (plan.operations[0]?.payload as { tok?: string } | undefined)?.tok ?? '';
      const searched = Date.now();
      let found = false;
      while (!found && Date.now() - searched < INDEX_WAIT_MILLISECONDS) {
        const page = await searchPage(client, `labels = "${label}"`, ['labels'], undefined);
        found = page.ok && page.value.issues.some((issue) => issue.key === key);
        if (!found) await new Promise((resolve) => setTimeout(resolve, 2000));
      }
      report(
        `the label was found by the search after ${Math.round((Date.now() - searched) / 1000)} s`,
      );
      expect(found, 'the search did not find the label in time').toBe(true);
      const [again] = await apply();
      expect(again).toEqual({
        status: 'applied',
        reason: `already created ${key}; nothing written`,
      });
    },
    TIMEOUT_MILLISECONDS * 2,
  );

  it(
    'sets its summary with jira.set',
    async () => {
      const key = sandboxIssue();
      const { apply } = await planned(
        'jira.set field=summary value=new',
        ['key', 'new'],
        [{ key, new: 'Tyto live check: summary set' }],
      );
      expect(await apply()).toEqual([{ status: 'applied', reason: '' }]);
    },
    TIMEOUT_MILLISECONDS,
  );

  it(
    'comments on it with jira.comment, once',
    async () => {
      const key = sandboxIssue();
      const { apply } = await planned(
        'jira.comment body=text',
        ['key', 'text'],
        [{ key, text: 'Tyto live check: one comment' }],
      );
      expect(await apply()).toEqual([{ status: 'applied', reason: '' }]);
      expect(await apply()).toEqual([
        { status: 'applied', reason: 'already commented; nothing written' },
      ]);
    },
    TIMEOUT_MILLISECONDS,
  );

  it(
    "assigns it to the token's account with jira.assign",
    async () => {
      const key = sandboxIssue();
      const { apply } = await planned('jira.assign to=me', ['key'], [{ key }]);
      const [assigned] = await apply();
      expect(assigned?.status, assigned?.reason).toBe('applied');
    },
    TIMEOUT_MILLISECONDS,
  );

  it(
    'moves it one transition with jira.transition',
    async () => {
      const key = sandboxIssue();
      const page = await searchPage(client, `key = ${key}`, ['status'], undefined);
      if (!page.ok) throw new Error(redacted(`${page.error.code}: ${page.error.message}`));
      const status = (page.value.issues[0]?.fields['status'] as { name?: string } | undefined)
        ?.name;
      const offered = await client.get(`/rest/api/3/issue/${key}/transitions`);
      if (!offered.ok) throw new Error(redacted(`${offered.error.code}: ${offered.error.message}`));
      const transitions =
        (offered.value as { transitions?: { to?: { name?: string } }[] }).transitions ?? [];
      const to = transitions
        .map((each) => each.to?.name)
        .find((name) => name !== undefined && name !== status);
      expect(to, 'the new issue offers no transition to another status').toBeDefined();
      report(`jira.transition takes one of ${transitions.length} transitions offered`);
      const { apply } = await planned(
        `jira.transition to="${to ?? ''}"`,
        ['key', 'status'],
        [{ key, status: status ?? null }],
      );
      const [moved] = await apply();
      expect(moved?.status, moved?.reason).toBe('applied');
    },
    TIMEOUT_MILLISECONDS,
  );
});
