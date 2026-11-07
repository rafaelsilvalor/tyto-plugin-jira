import type {
  AppliedBatchOperation,
  ApplyRequest,
  PluginHost,
  RecipeVerbContribution,
} from '@tyto/plugin-api';

import { record } from './columns.js';
import { resolveJiraConfig, type JiraConfig } from './config.js';
import { fingerprint } from './cursor.js';
import {
  CREATE_VERB_ID,
  argumentsProblem,
  verbFailed,
  type ApplyAnswer,
  type ArgumentSpec,
  type CellValue,
  type Diagnostic,
  type JsonValue,
  type PlanAnswer,
  type PlannedOperation,
  type PlanRequest,
  type Table,
} from './diagnostics.js';
import { jiraError, jiraOk, type JiraResult } from './errors.js';
import { mappedFields, projected, textOf } from './fields.js';
import { createJiraClient, type JiraClient } from './http.js';
import { ISSUE_KEY } from './pull.js';
import { searchPage } from './search.js';
import { converted, kindOf, type Target } from './set.js';
import { textToAdf } from './write/adf.js';
import {
  NOT_REACHED,
  answered,
  failedWith,
  openSession,
  systemClock,
  type WriteClock,
  type WriteHost,
} from './write/apply.js';
import { fieldCatalogue } from './write/catalogue.js';
import {
  columnNamed,
  planOf,
  planRefused,
  plannedFailure,
  plannedOperation,
  shortened,
  type Payload,
} from './write/plan.js';

export const CREATE_WRITE = 'create';

/** Issues per `POST /rest/api/3/issue/bulk`: the most Jira creates in one request. */
export const BULK_CREATE_SIZE = 50;
/** The longest summary Jira takes, in characters. */
export const MAX_SUMMARY_LENGTH = 255;
/** The longest description a plan carries, in UTF-8 bytes, as a comment's (ADR 0170). */
export const MAX_DESCRIPTION_BYTES = 1500;

const BULK_CREATE = '/rest/api/3/issue/bulk';
const PROJECT_KEY = /^[A-Z][A-Z0-9_]+$/;

const ARGUMENTS: readonly ArgumentSpec[] = [
  { name: 'project', type: 'text', required: true },
  { name: 'type', type: 'text', required: true },
  { name: 'summary', type: 'text', required: true },
  { name: 'description', type: 'text', required: false },
  { name: 'parent', type: 'text', required: false },
];

/** The parts of the host `jira.create` uses: a write's, and the cache its plan reads. */
export type CreateHost = WriteHost & Pick<PluginHost, 'cache' | 'log'>;

/**
 * `jira.create project=<key> type=<issue type> summary=<column> [description=<column>]
 * [parent=<column>]`: creates one issue per row, through `POST /rest/api/3/issue/bulk`, with
 * every column the `fields:` of the `jira` section maps written as `jira.set` writes it.
 *
 * Each issue is created with the label `tyto-<fingerprint>`, made of the site, the project and
 * the row's key, and left on it: **it is what makes applying twice create once.** Before
 * creating, Apply searches for the labels of its batch, and a row whose label is found answers
 * `applied` with the issue it already created.
 */
export function createVerb(
  host: CreateHost,
  clock: WriteClock = systemClock,
): RecipeVerbContribution {
  return {
    id: CREATE_VERB_ID,
    kind: 'action',
    arguments: ARGUMENTS,
    writes: [CREATE_WRITE],
    plan: (request) => planCreates(host, request, clock),
    apply: (request) => applyCreates(host, request, clock),
  };
}

/** The label of the issue a row creates: the same site, project and row, the same label. */
export function creationLabel(site: string, project: string, rowKey: string): string {
  return `tyto-${fingerprint(JSON.stringify([site, project, rowKey]))}`;
}

/** A column a mapping writes, with the field id and the way its cell is converted. */
interface MappedTarget extends Target {
  readonly column: string;
}

export async function planCreates(
  host: CreateHost,
  request: PlanRequest,
  clock: WriteClock = systemClock,
): Promise<PlanAnswer> {
  const { table } = request;
  const project = String(request.arguments['project'] ?? '').trim();
  const type = String(request.arguments['type'] ?? '').trim();
  if (!PROJECT_KEY.test(project)) {
    return planRefused(problem(`project= is '${project}', which is not a project key, such as EX`));
  }
  if (type === '') return planRefused(problem('type= names no issue type, such as Task'));
  const columns: Partial<Record<'summary' | 'description' | 'parent', string>> = {};
  for (const name of ['summary', 'description', 'parent'] as const) {
    const written = request.arguments[name];
    if (written === undefined || written === null) continue;
    const column = columnNamed(table, String(written).trim());
    if (column === undefined) {
      return planRefused(
        problem(`${name}= names '${String(written)}', which is not a column of the table`),
      );
    }
    columns[name] = column.name;
  }

  const config = await resolveJiraConfig(host, request.section);
  if (!config.ok) return planRefused(verbFailed(config.error, CREATE_VERB_ID));
  const named = Object.values(columns);
  const targets = await mappedTargets(host, config.value, request.section, table, named, clock);
  if (!targets.ok) return planRefused(targets.error);

  const site = new URL(config.value.baseUrl).hostname;
  const operations: PlannedOperation[] = [];
  for (const row of table.rows) {
    const summary = cellText(columns.summary === undefined ? null : row.values[columns.summary]);
    const preview = shortened(summary.replace(/\s+/g, ' '), 80);
    const described = `${project}: create ${type} "${preview}"`;
    const fail = (reason: string): void => {
      operations.push(plannedFailure(CREATE_WRITE, row.key, described, reason));
    };
    const why = `E_JIRA_PLAN: row ${row.key}`;
    if (summary === '') {
      fail(`${why} has no text in ${columns.summary ?? 'the summary column'}`);
      continue;
    }
    if (summary.length > MAX_SUMMARY_LENGTH) {
      fail(
        `${why}'s summary is ${summary.length} characters, over the ${MAX_SUMMARY_LENGTH} ` +
          'Jira takes',
      );
      continue;
    }
    const description = cellText(
      columns.description === undefined ? null : row.values[columns.description],
    );
    const bytes = new TextEncoder().encode(description).byteLength;
    if (bytes > MAX_DESCRIPTION_BYTES) {
      fail(
        `${why}'s description is ${bytes.toLocaleString('en-US')} bytes, over the ` +
          `${MAX_DESCRIPTION_BYTES.toLocaleString('en-US')} a plan carries; shorten it`,
      );
      continue;
    }
    const parent = cellText(columns.parent === undefined ? null : row.values[columns.parent]);
    if (parent !== '' && !ISSUE_KEY.test(parent)) {
      fail(`${why}'s parent ${JSON.stringify(parent.slice(0, 80))} is not an issue key`);
      continue;
    }
    const mapped: Record<string, JsonValue> = {};
    let refused: string | undefined;
    for (const target of targets.value) {
      const cell = row.values[target.column] ?? null;
      if (projected(cell) === null) continue;
      const value = converted(target, cell);
      if (typeof value === 'string') {
        refused = `${why}: ${value}`;
        break;
      }
      mapped[target.id] = value.v;
    }
    if (refused !== undefined) {
      fail(refused);
      continue;
    }
    operations.push(
      plannedOperation(
        CREATE_WRITE,
        row.key,
        parent === '' ? described : `${described} under ${parent}`,
        {
          p: project,
          t: type,
          s: summary,
          ...(description === '' ? {} : { d: description }),
          ...(parent === '' ? {} : { par: parent }),
          m: mapped,
          tok: creationLabel(site, project, row.key),
        },
      ),
    );
  }
  return planOf(`Jira ${site}`, operations);
}

/**
 * The table's columns the `fields:` of the section maps, besides those the arguments name,
 * each with its field's type off the catalogue. The catalogue is read only when there is one.
 */
async function mappedTargets(
  host: CreateHost,
  config: JiraConfig,
  section: unknown,
  table: Table,
  named: readonly string[],
  clock: WriteClock,
): Promise<
  { readonly ok: true; readonly value: readonly MappedTarget[] } | ReturnType<typeof failure>
> {
  const mapped = mappedFields(section);
  if (!mapped.ok) return failure(verbFailed(mapped.error, CREATE_VERB_ID));
  const present = mapped.value.flatMap((each) => {
    const column = columnNamed(table, each.column);
    return column === undefined || named.includes(column.name)
      ? []
      : [{ ...each, column: column.name }];
  });
  if (present.length === 0) return { ok: true, value: [] };

  const client = createJiraClient({ config, fetch: host.fetch });
  const catalogue = await fieldCatalogue(host, client, config, clock.now(), CREATE_VERB_ID);
  if (!catalogue.ok) return failure(verbFailed(catalogue.error, CREATE_VERB_ID));
  const targets: MappedTarget[] = [];
  for (const { column, id } of present) {
    const found = catalogue.value.find((each) => each.id === id);
    if (found === undefined) {
      return failure(
        problem(`writes the column ${column}, mapped to ${id}, and this site has no such field`),
      );
    }
    const kind = kindOf(found.schema);
    if (kind === undefined) {
      const { type, items } = found.schema;
      return failure(
        problem(
          `writes the column ${column}, a field of type ` +
            `${items === undefined ? (type ?? 'unknown') : `${type} of ${items}`}, which it ` +
            'cannot write; drop the column before the step',
        ),
      );
    }
    targets.push({ column, id, name: column, kind });
  }
  return { ok: true, value: targets };
}

function failure(diagnostic: Diagnostic): { readonly ok: false; readonly error: Diagnostic } {
  return { ok: false, error: diagnostic };
}

function cellText(cell: CellValue | undefined): string {
  if (cell === undefined || cell === null) return '';
  return (Array.isArray(cell) ? cell.map(String).join(', ') : textOf(cell)).trim();
}

interface PlannedCreate {
  readonly p: string;
  readonly t: string;
  readonly s: string;
  readonly d?: string;
  readonly par?: string;
  readonly m: Readonly<Record<string, JsonValue>>;
  readonly tok: string;
}

/**
 * One batch of a plan. One search finds the issues the batch already created, by label; the
 * others are created {@link BULK_CREATE_SIZE} per request, and each answer names the issue it
 * created, or Jira's own words for why that one was refused. After Jira refuses the token, no
 * other request is made.
 */
export async function applyCreates(
  host: WriteHost,
  request: ApplyRequest,
  clock: WriteClock = systemClock,
): Promise<ApplyAnswer> {
  const { operations } = request;
  const session = await openSession(host, request, clock);
  if (!session.ok) return answered(operations.map(() => failedWith(session.error)));
  const { client, finished, expired } = session.value;

  const outcomes: AppliedBatchOperation[] = new Array(operations.length);
  const pending: { readonly index: number; readonly planned: PlannedCreate }[] = [];
  operations.forEach((operation, index) => {
    const planned = decode(operation.payload);
    if (typeof planned === 'string') outcomes[index] = { status: 'failed', reason: planned };
    else pending.push({ index, planned });
  });

  const created = await createdBefore(
    client,
    pending.map(({ planned }) => planned.tok),
  );
  const remaining = pending.filter(({ index, planned }) => {
    if (!created.ok) outcomes[index] = failedWith(created.error);
    const key = created.ok ? created.value.get(planned.tok) : undefined;
    if (key !== undefined) {
      outcomes[index] = { status: 'applied', reason: `already created ${key}; nothing written` };
    }
    return outcomes[index] === undefined;
  });

  let refused: string | undefined;
  for (let start = 0; start < remaining.length; start += BULK_CREATE_SIZE) {
    const chunk = remaining.slice(start, start + BULK_CREATE_SIZE);
    if (refused === undefined && !expired()) {
      const answers = await bulkCreate(
        client,
        chunk.map(({ planned }) => planned),
      );
      chunk.forEach(({ index }, position) => {
        const answer = answers[position] ?? { status: 'failed', reason: UNMATCHED };
        outcomes[index] =
          answer.status === 'failed' && answer.reason?.includes(NOT_REACHED) === true
            ? { status: 'skipped', reason: NOT_REACHED }
            : answer;
        if (answer.reason?.startsWith('E_JIRA_AUTH') === true) refused = answer.reason;
      });
      continue;
    }
    for (const { index } of chunk) {
      outcomes[index] =
        refused === undefined
          ? { status: 'skipped', reason: NOT_REACHED }
          : { status: 'failed', reason: refused };
    }
  }
  return answered(outcomes.map(finished));
}

function decode(payload: JsonValue | undefined): PlannedCreate | string {
  const object = record(payload) as Payload | undefined;
  const planned = object?.['x'];
  if (typeof planned === 'string') return planned;
  const { p, t, s, d, par, m, tok } = object ?? {};
  const fields = record(m) as Readonly<Record<string, JsonValue>> | undefined;
  if (
    typeof p !== 'string' ||
    typeof t !== 'string' ||
    typeof s !== 'string' ||
    typeof tok !== 'string' ||
    fields === undefined ||
    (d !== undefined && typeof d !== 'string') ||
    (par !== undefined && typeof par !== 'string')
  ) {
    return (
      'E_JIRA_PLAN: this operation carries no payload this version of the plugin reads; run ' +
      'the cell again'
    );
  }
  return {
    p,
    t,
    s,
    ...(d === undefined ? {} : { d }),
    ...(par === undefined ? {} : { par }),
    m: fields,
    tok,
  };
}

/** By label, the issue that already carries it: created by an earlier Apply of the same row. */
async function createdBefore(
  client: JiraClient,
  labels: readonly string[],
): Promise<JiraResult<ReadonlyMap<string, string>>> {
  const found = new Map<string, string>();
  if (labels.length === 0) return jiraOk(found);
  const wanted = new Set(labels);
  const jql = `labels in (${labels.map((label) => `"${label}"`).join(', ')}) ORDER BY key ASC`;
  let token: string | undefined;
  for (;;) {
    const page = await searchPage(client, jql, ['labels'], token);
    if (!page.ok) return page;
    for (const issue of page.value.issues) {
      const carried = issue.fields['labels'];
      for (const label of Array.isArray(carried) ? carried : []) {
        if (typeof label === 'string' && wanted.has(label) && !found.has(label)) {
          found.set(label, issue.key);
        }
      }
    }
    const next = page.value.nextPageToken;
    if (page.value.isLast || next === undefined) return jiraOk(found);
    if (next === token) {
      return jiraError(
        'E_JIRA_RESPONSE',
        'the search for the labels answered the token it was given.',
      );
    }
    token = next;
  }
}

const UNMATCHED =
  'E_JIRA_RESPONSE: the bulk create answered what cannot be matched to its rows; run the ' +
  'cell and Apply again, which finds what was created by its label';

/** One `POST /issue/bulk`, answered per element in the order they were sent. */
async function bulkCreate(
  client: JiraClient,
  planned: readonly PlannedCreate[],
): Promise<readonly AppliedBatchOperation[]> {
  const answer = await client.post(BULK_CREATE, {
    issueUpdates: planned.map((each) => ({ fields: fieldsOf(each) })),
  });
  let body: Readonly<Record<string, unknown>> | undefined;
  if (answer.ok) body = record(answer.value);
  else if (answer.error.status === 400) body = record(answer.error.body);
  if (!answer.ok && !Array.isArray(body?.['errors'])) {
    return planned.map(() => failedWith(answer.error));
  }
  const issues = Array.isArray(body?.['issues']) ? body['issues'] : [];
  const errors = Array.isArray(body?.['errors']) ? body['errors'] : [];

  const refusals = new Map<number, string>();
  for (const each of errors) {
    const error = record(each);
    const element = error?.['failedElementNumber'];
    if (typeof element !== 'number' || !Number.isInteger(element)) continue;
    if (element < 0 || element >= planned.length) continue;
    const status = typeof error?.['status'] === 'number' ? ` (${error['status']})` : '';
    refusals.set(
      element,
      `E_JIRA_HTTP: Jira refused to create it${status}: ${elementMessage(error?.['elementErrors'])}`,
    );
  }
  const accepted = planned.flatMap((_, index) => (refusals.has(index) ? [] : [index]));
  const keys = issues.map((issue) => record(issue)?.['key']);
  const matched =
    keys.length === accepted.length && keys.every((key) => typeof key === 'string' && key !== '');
  return planned.map((_, index): AppliedBatchOperation => {
    const refusal = refusals.get(index);
    if (refusal !== undefined) return { status: 'failed', reason: refusal };
    if (!matched) return { status: 'failed', reason: UNMATCHED };
    return { status: 'applied', reason: `created ${String(keys[accepted.indexOf(index)])}` };
  });
}

/** The fields of one new issue: the mapped ones, then those the step names, then the label. */
function fieldsOf(planned: PlannedCreate): Readonly<Record<string, unknown>> {
  const labels = planned.m['labels'];
  return {
    ...planned.m,
    project: { key: planned.p },
    issuetype: { name: planned.t },
    summary: planned.s,
    ...(planned.d === undefined ? {} : { description: textToAdf(planned.d) }),
    ...(planned.par === undefined ? {} : { parent: { key: planned.par } }),
    labels: [...(Array.isArray(labels) ? labels : []), planned.tok],
  };
}

/** An element's `errorMessages` and `errors`, as Jira words them. */
function elementMessage(value: unknown): string {
  const errors = record(value);
  const messages = [
    ...(Array.isArray(errors?.['errorMessages']) ? errors['errorMessages'].map(String) : []),
    ...Object.entries(record(errors?.['errors']) ?? {}).map(
      ([field, message]) => `${field}: ${String(message)}`,
    ),
  ];
  return messages.length === 0 ? 'Jira gave no reason' : messages.join('; ');
}

function problem(text: string) {
  return argumentsProblem(text, CREATE_VERB_ID);
}
