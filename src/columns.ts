import { jiraError, jiraOk, type JiraResult } from './errors.js';
import type { CellValue, Column, Row } from './diagnostics.js';

export const ORIGIN = 'jira';

/**
 * The fifteen columns every `jira.pull` answers, in this order, whatever the selector. The
 * `fields:` section's mapped columns come after them (TYTO-386 PR 3b).
 */
export const FIXED_COLUMNS: readonly Column[] = (
  [
    ['key', 'text'],
    ['url', 'link'],
    ['project', 'text'],
    ['issuetype', 'text'],
    ['status', 'text'],
    ['status_category', 'text'],
    ['summary', 'text'],
    ['parent_key', 'text'],
    ['assignee', 'text'],
    ['labels', 'list'],
    ['created', 'datetime'],
    ['updated', 'datetime'],
    ['description_urls', 'list'],
    ['comment_urls', 'list'],
    ['parent_description_urls', 'list'],
  ] as const
).map(([name, type]) => ({ name, type, origin: ORIGIN }));

/** The Jira fields the fixed columns read, asked for by name so a search sends no others. */
export const FIXED_FIELDS: readonly string[] = [
  'summary',
  'project',
  'issuetype',
  'status',
  'parent',
  'assignee',
  'labels',
  'created',
  'updated',
  'description',
  'comment',
];

/** One issue as a search answered it: the shape was checked, the fields were not. */
export interface PulledIssue {
  readonly id: string;
  readonly key: string;
  readonly fields: Readonly<Record<string, unknown>>;
}

/** What a row needs besides its issue. */
export interface RowContext {
  readonly baseUrl: string;
  readonly fetchedAt: string;
  /** Every comment's ADF body, in the order they were made. */
  readonly commentBodies: readonly unknown[];
  /** The parent's ADF description, or `undefined` with no parent or none found. */
  readonly parentDescription: unknown;
}

export function rowOf(issue: PulledIssue, context: RowContext): JiraResult<Row> {
  const { fields } = issue;
  const created = isoUtc(fields['created'], issue.key, 'created');
  if (!created.ok) return created;
  const updated = isoUtc(fields['updated'], issue.key, 'updated');
  if (!updated.ok) return updated;
  const status = record(fields['status']);
  const values: Readonly<Record<string, CellValue>> = {
    key: issue.key,
    url: `${context.baseUrl}/browse/${issue.key}`,
    project: text(record(fields['project'])?.['key']),
    issuetype: text(record(fields['issuetype'])?.['name']),
    status: text(status?.['name']),
    status_category: text(record(status?.['statusCategory'])?.['name']),
    summary: text(fields['summary']),
    parent_key: text(record(fields['parent'])?.['key']),
    assignee: text(record(fields['assignee'])?.['displayName']),
    labels: Array.isArray(fields['labels'])
      ? fields['labels'].filter((label): label is string => typeof label === 'string')
      : [],
    created: created.value,
    updated: updated.value,
    description_urls: adfUrls(fields['description']),
    comment_urls: unique(context.commentBodies.flatMap((body) => adfUrls(body))),
    parent_description_urls: adfUrls(context.parentDescription),
  };
  return jiraOk({
    key: issue.key,
    values,
    provenance: { source: ORIGIN, id: issue.id, fetchedAt: context.fetchedAt },
  });
}

const URL_IN_TEXT = /https?:\/\/[^\s<>"'`{}|\\^[\]]+/g;
const TRAILING_PUNCTUATION = /[.,;:!?)]+$/;
const CARD_NODES: ReadonlySet<string> = new Set(['inlineCard', 'blockCard', 'embedCard']);

/**
 * Every URL an Atlassian Document Format value holds, first occurrence first: a link mark's
 * `href`, a smart card's `url`, and any URL written in plain text. Walked in document order,
 * marks before text, so a linked word's target comes before a URL the word itself spells.
 */
export function adfUrls(document: unknown): string[] {
  const found: string[] = [];
  const visit = (node: unknown): void => {
    const current = record(node);
    if (current === undefined) return;
    if (Array.isArray(current['marks'])) {
      for (const mark of current['marks']) {
        const markRecord = record(mark);
        const href = record(markRecord?.['attrs'])?.['href'];
        if (markRecord?.['type'] === 'link' && typeof href === 'string') found.push(href);
      }
    }
    const type = current['type'];
    const url = record(current['attrs'])?.['url'];
    if (typeof type === 'string' && CARD_NODES.has(type) && typeof url === 'string') {
      found.push(url);
    }
    if (type === 'text' && typeof current['text'] === 'string') {
      for (const match of current['text'].matchAll(URL_IN_TEXT)) {
        found.push(match[0].replace(TRAILING_PUNCTUATION, ''));
      }
    }
    if (Array.isArray(current['content'])) current['content'].forEach(visit);
  };
  visit(document);
  return unique(found);
}

const JIRA_DATETIME = /^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?)(Z|[+-]\d{2}:?\d{2})$/;

/**
 * Jira's `2026-10-01T10:15:30.000-0300` as ISO 8601 in UTC, `2026-10-01T13:15:30.000Z`, so two
 * sites in two time zones answer comparable text. Jira writes the offset without a colon,
 * which `Date.parse` is not bound to read, so the colon is put back first.
 */
export function isoUtc(value: unknown, key: string, field: string): JiraResult<string | null> {
  if (value === undefined || value === null) return jiraOk(null);
  const match = typeof value === 'string' ? JIRA_DATETIME.exec(value.trim()) : null;
  const local = match?.[1];
  const zone = match?.[2];
  if (local !== undefined && zone !== undefined) {
    const offset =
      zone === 'Z' || zone.includes(':') ? zone : `${zone.slice(0, 3)}:${zone.slice(3)}`;
    const time = Date.parse(`${local}${offset}`);
    if (!Number.isNaN(time)) return jiraOk(new Date(time).toISOString());
  }
  return jiraError(
    'E_JIRA_RESPONSE',
    `${key}'s ${field} is ${JSON.stringify(value)}, which is not a Jira date and time.`,
  );
}

export function record(value: unknown): Readonly<Record<string, unknown>> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Readonly<Record<string, unknown>>)
    : undefined;
}

function text(value: unknown): string | null {
  return typeof value === 'string' ? value : null;
}

function unique(values: readonly string[]): string[] {
  return [...new Set(values)];
}
