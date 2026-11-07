import { record, rowOf, type PulledIssue } from './columns.js';
import type { Row } from './diagnostics.js';
import { jiraOk, type JiraResult } from './errors.js';
import { mappedValues, type MappedField, type MappedTypes } from './fields.js';
import type { JiraClient } from './http.js';
import { commentBodies, parentDescriptions } from './search.js';

/**
 * What the rows of some issues need besides the issues: every comment and each parent's
 * description. Shared by `jira.pull`, a page at a time, and `jira.refresh`, all at once.
 */
export interface IssuesRead {
  readonly parents: ReadonlyMap<string, unknown>;
  /** Each issue's comment bodies, in the issues' order. */
  readonly comments: readonly (readonly unknown[])[];
}

export async function readIssues(
  client: JiraClient,
  issues: readonly PulledIssue[],
): Promise<JiraResult<IssuesRead>> {
  const parents = await parentDescriptions(client, issues);
  if (!parents.ok) return parents;
  const comments: (readonly unknown[])[] = [];
  for (const issue of issues) {
    const bodies = await commentBodies(client, issue);
    if (!bodies.ok) return bodies;
    comments.push(bodies.value);
  }
  return jiraOk({ parents: parents.value, comments });
}

export interface IssueRowContext {
  readonly baseUrl: string;
  readonly fetchedAt: string;
  readonly mapped: readonly MappedField[];
  readonly types: MappedTypes;
}

/** One issue's row: the fifteen fixed columns, then the mapped ones. */
export function issueRow(
  issue: PulledIssue,
  comments: readonly unknown[],
  parents: ReadonlyMap<string, unknown>,
  context: IssueRowContext,
): JiraResult<Row> {
  const parentKey = record(issue.fields['parent'])?.['key'];
  const row = rowOf(issue, {
    baseUrl: context.baseUrl,
    fetchedAt: context.fetchedAt,
    commentBodies: comments,
    parentDescription: typeof parentKey === 'string' ? parents.get(parentKey) : undefined,
  });
  if (!row.ok) return row;
  const values = mappedValues(issue.fields, issue.key, context.mapped, context.types);
  if (!values.ok) return values;
  return jiraOk({ ...row.value, values: { ...row.value.values, ...values.value } });
}
