import { FIXED_COLUMNS, ORIGIN, isoUtc, record } from './columns.js';
import type { CellValue, Column, Row } from './diagnostics.js';
import { jiraError, jiraOk, type JiraResult } from './errors.js';
import type { JiraClient } from './http.js';

/** One column the `fields:` section maps: its name in the table and the Jira field it reads. */
export interface MappedField {
  readonly column: string;
  readonly id: string;
}

/** The column types a mapped field can answer, by name, as the cursor's `m` carries them. */
export type MappedTypes = Readonly<Record<string, MappedType>>;
type MappedType = 'text' | 'number' | 'date' | 'datetime' | 'list';

const COLUMN_NAME = /^[a-z][a-z0-9_]*$/;
const FIXED_NAMES: ReadonlySet<string> = new Set(FIXED_COLUMNS.map((column) => column.name));
const MAPPED_TYPES: ReadonlySet<string> = new Set(['text', 'number', 'date', 'datetime', 'list']);
const FIELD_CATALOGUE = '/rest/api/3/field';

/**
 * The `fields:` of the `jira` section of `.tyto/project.json`, `{<column>: <field id>}`, in the
 * order it was written, or why it is refused — before any request. A column name is lower
 * case, starts with a letter, and is not one of the fifteen fixed columns, so a mapped column
 * never shadows what every pull answers.
 */
export function mappedFields(section: unknown): JiraResult<readonly MappedField[]> {
  const fields = record(section)?.['fields'];
  if (fields === undefined || fields === null) return jiraOk([]);
  const written = record(fields);
  if (written === undefined) {
    return configError(
      'fields in the jira section of .tyto/project.json is not an object of column names ' +
        'and field ids, such as {"story_points": "customfield_10016"}',
    );
  }
  const mapped: MappedField[] = [];
  for (const [column, id] of Object.entries(written)) {
    if (!COLUMN_NAME.test(column)) {
      return configError(
        `fields names a column '${column}'; a column name is lower case letters, digits and ` +
          '_, starting with a letter, such as story_points',
      );
    }
    if (FIXED_NAMES.has(column)) {
      return configError(
        `fields names a column '${column}', which every pull already answers; choose another ` +
          'name',
      );
    }
    if (typeof id !== 'string' || id.trim() === '') {
      return configError(
        `fields maps ${column} to ${JSON.stringify(id)}, which is not a field id, such as ` +
          'customfield_10016',
      );
    }
    mapped.push({ column, id: id.trim() });
  }
  return jiraOk(mapped);
}

/**
 * Each mapped column's type, read off the site's field catalogue. Asked on the first page
 * only: later pages carry the answer in their cursor, so one pull reads the catalogue once.
 * An id the site does not have is refused, and when what was written is a field's name rather
 * than its id, the message names the id.
 */
export async function mappedTypes(
  client: JiraClient,
  mapped: readonly MappedField[],
): Promise<JiraResult<MappedTypes>> {
  if (mapped.length === 0) return jiraOk({});
  const answer = await client.get(FIELD_CATALOGUE);
  if (!answer.ok) return answer;
  if (!Array.isArray(answer.value)) {
    return jiraError('E_JIRA_RESPONSE', `GET ${FIELD_CATALOGUE} answered no list of fields.`);
  }
  const catalogue = answer.value.map((field) => record(field)).filter((field) => !!field);
  const types: Record<string, MappedType> = {};
  for (const { column, id } of mapped) {
    const field = catalogue.find((candidate) => candidate['id'] === id);
    if (field === undefined) return configError(unknownField(column, id, catalogue));
    types[column] = typeOfSchema(record(field['schema'])?.['type']);
  }
  return jiraOk(types);
}

function unknownField(
  column: string,
  written: string,
  catalogue: readonly Readonly<Record<string, unknown>>[],
): string {
  const lowered = written.toLowerCase();
  const named = catalogue
    .filter((field) => typeof field['name'] === 'string' && field['name'].toLowerCase() === lowered)
    .map((field) => field['id'])
    .filter((id): id is string => typeof id === 'string');
  if (named.length === 0) {
    return `fields maps ${column} to '${written}', and this site has no field with that id`;
  }
  return (
    `fields maps ${column} to '${written}', which is a field's name, not its id; write ` +
    named.join(' or ')
  );
}

/**
 * Jira's `schema.type` as a column type. An option, a user, a priority and the other objects
 * are text, read from what a person sees of them.
 */
function typeOfSchema(type: unknown): MappedType {
  switch (type) {
    case 'number':
      return 'number';
    case 'date':
      return 'date';
    case 'datetime':
      return 'datetime';
    case 'array':
      return 'list';
    default:
      return 'text';
  }
}

/** Whether a cursor's `m` holds exactly the mapped columns, each with a type this plugin writes. */
export function sameColumns(
  types: Readonly<Record<string, string>>,
  mapped: readonly MappedField[],
): types is MappedTypes {
  const names = Object.keys(types);
  return (
    names.length === mapped.length &&
    mapped.every(({ column }) => MAPPED_TYPES.has(types[column] ?? '')) &&
    names.every((name) => mapped.some(({ column }) => column === name))
  );
}

/** The mapped columns, after the fixed ones, in the order the section wrote them. */
export function mappedColumns(
  mapped: readonly MappedField[],
  types: MappedTypes,
): readonly Column[] {
  return mapped.map(({ column }) => ({
    name: column,
    type: types[column] ?? 'text',
    origin: ORIGIN,
  }));
}

/** One issue's mapped values, by column, or the first one that is not what its type says. */
export function mappedValues(
  fields: Readonly<Record<string, unknown>>,
  key: string,
  mapped: readonly MappedField[],
  types: MappedTypes,
): JiraResult<Readonly<Record<string, CellValue>>> {
  const values: Record<string, CellValue> = {};
  for (const { column, id } of mapped) {
    const value = cellOf(types[column] ?? 'text', fields[id], key, column);
    if (!value.ok) return value;
    values[column] = value.value;
  }
  return jiraOk(values);
}

const JIRA_DATE = /^\d{4}-\d{2}-\d{2}$/;

function cellOf(
  type: MappedType,
  value: unknown,
  key: string,
  column: string,
): JiraResult<CellValue> {
  if (type === 'list') {
    if (value === undefined || value === null) return jiraOk([]);
    return Array.isArray(value)
      ? jiraOk(value.map((item) => (typeof item === 'number' ? item : textOf(item))))
      : jiraOk([textOf(value)]);
  }
  if (value === undefined || value === null) return jiraOk(null);
  switch (type) {
    case 'number':
      if (typeof value === 'number' && Number.isFinite(value)) return jiraOk(value);
      return notA(key, column, value, 'number');
    case 'date':
      if (typeof value === 'string' && JIRA_DATE.test(value)) return jiraOk(value);
      return notA(key, column, value, 'date, such as 2026-10-01');
    case 'datetime':
      return isoUtc(value, key, column);
    case 'text':
      return jiraOk(textOf(value));
  }
}

function notA(key: string, column: string, value: unknown, what: string): JiraResult<never> {
  return jiraError(
    'E_JIRA_RESPONSE',
    `${key}'s ${column} is ${JSON.stringify(value)}, which is not a ${what}.`,
  );
}

/**
 * What a person sees of a value: text as it is, a document's text, and an option, a user or a
 * priority by its `value`, `name` or `displayName`. Anything else is its JSON, so nothing is
 * dropped without a trace.
 */
export function textOf(value: unknown): string {
  if (typeof value === 'string') return value;
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  const object = record(value);
  if (object?.['type'] === 'doc') return documentText(object);
  for (const name of ['value', 'name', 'displayName']) {
    const shown = object?.[name];
    if (typeof shown === 'string') return shown;
  }
  return JSON.stringify(value) ?? '';
}

/** An Atlassian Document Format value's text, one line per block. */
export function documentText(document: Readonly<Record<string, unknown>>): string {
  const inline = (node: unknown): string => {
    const current = record(node);
    if (current === undefined) return '';
    if (typeof current['text'] === 'string') return current['text'];
    if (current['type'] === 'hardBreak') return '\n';
    return Array.isArray(current['content']) ? current['content'].map(inline).join('') : '';
  };
  const blocks = Array.isArray(document['content']) ? document['content'] : [];
  return blocks
    .map(inline)
    .filter((line) => line !== '')
    .join('\n');
}

/**
 * A field's value as a cell shows it, whatever its type, for a write's drift check: the same
 * text, number or list a pull answers, with every empty value (`null`, `''`, `[]`) as `null`,
 * so a table's cell and what Jira holds now compare without knowing the column's type.
 */
export function projected(value: unknown): CellValue {
  if (value === undefined || value === null || value === '') return null;
  if (Array.isArray(value)) {
    if (value.length === 0) return null;
    return value.map((item) => (typeof item === 'number' ? item : textOf(item)));
  }
  if (typeof value === 'number') return value;
  return textOf(value);
}

/**
 * Whether `only=<column>` keeps a row: the true cell of a boolean column, or a cell of any other
 * column that holds something, such as the `<column>_push` that Tyto's `decide` leaves empty on
 * every row it does not push.
 */
export function chosenBy(row: Row, column: Column): boolean {
  const cell = row.values[column.name] ?? null;
  if (column.type === 'boolean') return cell === true;
  const shown = projected(cell);
  return shown !== null && (typeof shown !== 'string' || shown.trim() !== '');
}

function configError<T>(message: string): JiraResult<T> {
  return jiraError('E_JIRA_CONFIG', `${message}.`);
}
