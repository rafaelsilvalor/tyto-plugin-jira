import type {
  AppliedBatchOperation,
  ApplyRequest,
  PluginHost,
  RecipeVerbContribution,
} from '@tyto/plugin-api';

import { ACCOUNT_ID } from './assign.js';
import { record } from './columns.js';
import { resolveJiraConfig } from './config.js';
import { fingerprint } from './cursor.js';
import {
  SET_VERB_ID,
  argumentsProblem,
  verbFailed,
  type ApplyAnswer,
  type ArgumentSpec,
  type CellValue,
  type JsonValue,
  type PlanAnswer,
  type PlannedOperation,
  type PlanRequest,
} from './diagnostics.js';
import { chosenBy, mappedFields, projected, textOf } from './fields.js';
import { createJiraClient } from './http.js';
import { textToAdf } from './write/adf.js';
import {
  applyBatch,
  failedWith,
  systemClock,
  type CurrentIssue,
  type WriteClock,
  type WriteContext,
  type WriteHost,
} from './write/apply.js';
import { fieldCatalogue, type CatalogueField } from './write/catalogue.js';
import {
  columnNamed,
  issueKeyOf,
  planOf,
  planRefused,
  plannedFailure,
  plannedOperation,
  shortened,
  type Payload,
} from './write/plan.js';

export const SET_WRITE = 'field';

const ARGUMENTS: readonly ArgumentSpec[] = [
  { name: 'field', type: 'text', required: true },
  { name: 'value', type: 'text', required: true },
  { name: 'only', type: 'text' },
  { name: 'from-column', type: 'text' },
];

/** The parts of the host `jira.set` uses: a write's, and the cache its plan reads. */
export type SetHost = WriteHost & Pick<PluginHost, 'cache' | 'log'>;

/** The fields every site has, which `field=` names without a `fields:` mapping. */
const BUILT_IN: Readonly<Record<string, CatalogueField['schema']>> = {
  summary: { type: 'string' },
  labels: { type: 'array', items: 'string' },
  duedate: { type: 'date' },
  priority: { type: 'priority' },
};

/** How a cell becomes the value Jira takes, by the field's `schema`. */
export type Kind =
  'text' | 'textarea' | 'number' | 'date' | 'option' | 'user' | 'priority' | 'labels' | 'options';

const TEXTAREA = ':textarea';
const DATE = /^\d{4}-\d{2}-\d{2}$/;

/**
 * `jira.set field=<field> value=<column> [only=<column>] [from-column=<column>]`: sets one field
 * of each row's issue to the row's cell, through `PUT /issue/{key}`.
 *
 * `field=` is a column the `fields:` of the `jira` section maps, or one of `summary`, `labels`,
 * `duedate` and `priority`. The cell is converted by the field's type, read off the site's field
 * catalogue: an option by its value, a user by account id, a paragraph field as a document.
 * When the table holds a column named like the field, Apply checks Jira still holds what that
 * column read, so an issue edited since the plan fails alone. `from-column=` names that column
 * instead, as after `jira.refresh prefix=jira_`, when the column named like the field is the
 * sheet's own.
 *
 * `only=` plans the rows whose cell in that column is true or holds something, and nothing for
 * the others: a shared field is written back only on the rows a `decide` step chose to push,
 * while an empty cell on a chosen row still clears the field.
 */
export function setVerb(host: SetHost, clock: WriteClock = systemClock): RecipeVerbContribution {
  return {
    id: SET_VERB_ID,
    kind: 'action',
    arguments: ARGUMENTS,
    writes: [SET_WRITE],
    plan: (request) => planSets(host, request, clock),
    apply: (request) => applySets(host, request, clock),
  };
}

export interface Target {
  readonly id: string;
  readonly name: string;
  readonly kind: Kind;
}

export async function planSets(
  host: SetHost,
  request: PlanRequest,
  clock: WriteClock = systemClock,
): Promise<PlanAnswer> {
  const { table } = request;
  const field = String(request.arguments['field'] ?? '').trim();
  const valueName = String(request.arguments['value'] ?? '').trim();
  const valueColumn = columnNamed(table, valueName);
  if (valueColumn === undefined) {
    return planRefused(problem(`value= names '${valueName}', which is not a column of the table`));
  }
  const onlyName = request.arguments['only'];
  const only = onlyName === undefined ? undefined : columnNamed(table, String(onlyName).trim());
  if (onlyName !== undefined && only === undefined) {
    return planRefused(
      problem(`only= names '${String(onlyName)}', which is not a column of the table`),
    );
  }
  const fromName = request.arguments['from-column'];
  const readFrom = fromName === undefined ? undefined : columnNamed(table, String(fromName).trim());
  if (fromName !== undefined && readFrom === undefined) {
    return planRefused(
      problem(`from-column= names '${String(fromName)}', which is not a column of the table`),
    );
  }

  const config = await resolveJiraConfig(host, request.section);
  if (!config.ok) return planRefused(verbFailed(config.error, SET_VERB_ID));
  const mapped = mappedFields(request.section);
  if (!mapped.ok) return planRefused(verbFailed(mapped.error, SET_VERB_ID));

  const name = field.toLowerCase();
  const mapping = mapped.value.find((each) => each.column === name);
  let schema: CatalogueField['schema'] | undefined = BUILT_IN[name];
  let id = name;
  if (mapping !== undefined) {
    const client = createJiraClient({ config: config.value, fetch: host.fetch });
    const catalogue = await fieldCatalogue(host, client, config.value, clock.now());
    if (!catalogue.ok) return planRefused(verbFailed(catalogue.error, SET_VERB_ID));
    const found = catalogue.value.find((each) => each.id === mapping.id);
    if (found === undefined) {
      return planRefused(
        problem(`field= names ${name}, mapped to ${mapping.id}, and this site has no such field`),
      );
    }
    schema = found.schema;
    id = mapping.id;
  }
  if (schema === undefined) {
    return planRefused(
      problem(
        `field= names '${field}', which is neither a column the fields of the jira section map ` +
          'nor summary, labels, duedate or priority',
      ),
    );
  }
  const kind = kindOf(schema);
  if (kind === undefined) {
    const type = schema.items === undefined ? schema.type : `${schema.type} of ${schema.items}`;
    return planRefused(
      problem(`field= names ${name}, a field of type ${type ?? 'unknown'}, which it cannot write`),
    );
  }
  const target: Target = { id, name, kind };
  const before = readFrom ?? columnNamed(table, name);

  const operations: PlannedOperation[] = [];
  for (const row of table.rows) {
    if (only !== undefined && !chosenBy(row, only)) continue;
    const key = issueKeyOf(row);
    if (key === undefined) {
      operations.push(
        plannedFailure(
          SET_WRITE,
          row.key,
          `${row.key}: set ${name}`,
          `E_JIRA_PLAN: row ${row.key} names no issue key in its key column or its key`,
        ),
      );
      continue;
    }
    const value = converted(target, row.values[valueColumn.name] ?? null);
    if (typeof value === 'string') {
      operations.push(
        plannedFailure(SET_WRITE, row.key, `${key}: set ${name}`, `E_JIRA_PLAN: ${key}: ${value}`),
      );
      continue;
    }
    const from = before === undefined ? undefined : projected(row.values[before.name] ?? null);
    const change = from === undefined ? shown(value.v) : `${shown(from)} → ${shown(value.v)}`;
    operations.push(
      plannedOperation(SET_WRITE, row.key, `${key}: ${name} ${change}`, {
        k: key,
        fid: id,
        ...(from === undefined ? {} : { h: hashOf(from) }),
        v: value.v,
      }),
    );
  }
  return planOf(`Jira ${new URL(config.value.baseUrl).hostname}`, operations);
}

/** The `schema` of a field as the way its value is written, or `undefined` when it is not one. */
export function kindOf(schema: CatalogueField['schema']): Kind | undefined {
  switch (schema.type) {
    case 'string':
      return schema.custom?.endsWith(TEXTAREA) === true ? 'textarea' : 'text';
    case 'number':
    case 'date':
    case 'option':
    case 'user':
    case 'priority':
      return schema.type;
    case 'array':
      if (schema.items === 'string') return 'labels';
      if (schema.items === 'option') return 'options';
      return undefined;
    default:
      return undefined;
  }
}

/** The value Jira takes for the cell, or why the cell cannot be written. */
export function converted(target: Target, cell: CellValue): { readonly v: JsonValue } | string {
  const empty = projected(cell) === null;
  const text = Array.isArray(cell) ? cell.map(String).join(', ') : String(cell ?? '').trim();
  switch (target.kind) {
    case 'labels':
    case 'options': {
      const items = (Array.isArray(cell) ? cell.map(String) : text.split(',')).flatMap((item) =>
        target.kind === 'labels' ? item.split(/[\s,]+/) : [item],
      );
      const kept = items.map((item) => item.trim()).filter((item) => item !== '');
      return { v: target.kind === 'labels' ? kept : kept.map((value) => ({ value })) };
    }
    case 'text':
      if (empty && target.id === 'summary') return 'a summary cannot be empty';
      return { v: empty ? null : text };
    case 'textarea':
      return { v: empty ? null : (textToAdf(text) as unknown as JsonValue) };
    case 'number': {
      if (empty) return { v: null };
      const number = typeof cell === 'number' ? cell : Number(text);
      if (text === '' || !Number.isFinite(number)) {
        return `${JSON.stringify(text.slice(0, 80))} is not a number for ${target.name}`;
      }
      return { v: number };
    }
    case 'date':
      if (empty) return { v: null };
      if (!DATE.test(text)) {
        return `${JSON.stringify(text.slice(0, 80))} is not a date, such as 2026-10-01, for ${target.name}`;
      }
      return { v: text };
    case 'option':
      return { v: empty ? null : { value: text } };
    case 'priority':
      if (empty) return 'a priority cannot be empty';
      return { v: { name: text } };
    case 'user':
      if (empty) return { v: null };
      if (!ACCOUNT_ID.test(text)) {
        return (
          `${JSON.stringify(text.slice(0, 80))} is not a Jira account id for ${target.name}; ` +
          'write the id, not a name or an email'
        );
      }
      return { v: { accountId: text } };
  }
}

/** A value as a description shows it: a user by account id, anything else as a cell. */
export function shown(value: unknown): string {
  const accountId = record(value)?.['accountId'];
  const cell = projected(value);
  const text =
    typeof accountId === 'string'
      ? accountId
      : Array.isArray(cell)
        ? cell.join(', ')
        : textOf(cell ?? '(empty)');
  return shortened(text, 80);
}

/** What the drift check compares: the value as a cell shows it, fingerprinted. */
function hashOf(cell: CellValue): string {
  return fingerprint(JSON.stringify(cell));
}

interface PlannedSet {
  readonly k: string;
  readonly fid: string;
  /** The fingerprint of the field as the table read it; absent when it had no such column. */
  readonly h?: string;
  readonly v: JsonValue;
}

export function applySets(
  host: WriteHost,
  request: ApplyRequest,
  clock: WriteClock = systemClock,
): Promise<ApplyAnswer> {
  return applyBatch(
    host,
    request,
    {
      decode,
      fields: (planned) => planned.map((each) => each.fid),
      write: set,
    },
    clock,
  );
}

function decode(payload: Payload): PlannedSet | undefined {
  const { k, fid, h, v } = payload;
  if (typeof k !== 'string' || typeof fid !== 'string' || v === undefined) return undefined;
  if (h !== undefined && typeof h !== 'string') return undefined;
  return { k, fid, ...(h === undefined ? {} : { h }), v };
}

async function set(
  planned: PlannedSet,
  issue: CurrentIssue,
  context: WriteContext,
): Promise<AppliedBatchOperation> {
  const { k: key, fid } = planned;
  const now = issue.fields[fid] ?? null;
  if (holds(now, planned.v)) {
    return { status: 'applied', reason: `already ${fid} = ${shown(now)}; nothing written` };
  }
  if (planned.h !== undefined && hashOf(projected(now)) !== planned.h) {
    return {
      status: 'failed',
      reason:
        `E_JIRA_MOVED: ${key}'s ${fid} is ${shown(now)} now, not what the table read when ` +
        'planned; run the cell again',
    };
  }
  const put = await context.client.put(`/rest/api/3/issue/${encodeURIComponent(key)}`, {
    fields: { [fid]: planned.v },
  });
  if (!put.ok) return failedWith(put.error);
  issue.fields[fid] = planned.v;
  return { status: 'applied' };
}

/**
 * Whether Jira already holds the value a write would set: an option, a user or a priority by
 * its value, account id or name; a document by its text; a list as the same items in any order.
 */
function holds(current: unknown, wanted: JsonValue): boolean {
  if (wanted === null) return projected(current) === null;
  if (Array.isArray(wanted)) {
    const items = Array.isArray(current) ? current : [];
    return (
      items.length === wanted.length &&
      wanted.every((each) => items.some((item) => holds(item, each)))
    );
  }
  const object = record(wanted);
  if (object === undefined) return current === wanted;
  if (object['type'] === 'doc') return projected(current) === projected(wanted);
  for (const name of ['accountId', 'value', 'name']) {
    if (typeof object[name] === 'string') return record(current)?.[name] === object[name];
  }
  return false;
}

function problem(text: string) {
  return argumentsProblem(text, SET_VERB_ID);
}
