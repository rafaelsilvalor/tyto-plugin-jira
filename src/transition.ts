import type { AppliedBatchOperation, ApplyRequest, RecipeVerbContribution } from '@tyto/plugin-api';

import { record } from './columns.js';
import { resolveJiraConfig } from './config.js';
import {
  TRANSITION_VERB_ID,
  argumentsProblem,
  verbFailed,
  type ApplyAnswer,
  type ArgumentSpec,
  type Diagnostic,
  type PlanAnswer,
  type PlannedOperation,
  type PlanRequest,
  type Row,
} from './diagnostics.js';
import { jiraError, jiraOk, type JiraResult } from './errors.js';
import type { JiraClient } from './http.js';
import {
  applyBatch,
  failedWith,
  same,
  systemClock,
  type CurrentIssue,
  type WriteClock,
  type WriteContext,
  type WriteHost,
} from './write/apply.js';
import {
  columnNamed,
  issueKeyOf,
  planOf,
  planRefused,
  plannedFailure,
  plannedOperation,
  type Payload,
} from './write/plan.js';
import { shortestPath, workflowNames, workflowOf, type Workflow } from './write/workflows.js';

export const TRANSITION_WRITE = 'transition';

const ARGUMENTS: readonly ArgumentSpec[] = [
  { name: 'to', type: 'text' },
  { name: 'to-column', type: 'text' },
  { name: 'workflow', type: 'text' },
  { name: 'workflow-column', type: 'text' },
  { name: 'from-column', type: 'text' },
];

/** How many statuses a planned failure names as reached, so its reason stays short. */
const REACHED_NAMED = 12;

/**
 * `jira.transition (to=<status> | to-column=<column>) [workflow=<name> | workflow-column=<column>]
 * [from-column=<column>]`: moves each row's issue to a status, from the status the table read
 * (`jira.pull`'s `status` column, or the one `from-column=` names).
 *
 * `to=` is one status for every row; `to-column=` reads each row's own, and a row whose cell is
 * empty plans nothing, which is how a recipe moves only the rows a step before it chose. With a
 * workflow, the walk is the shortest path through that workflow of the `workflows` key of the
 * `jira` section, one checked transition per step; without one, one direct step. The plan reads
 * no Jira: a status the workflow cannot reach is a planned failure of that row alone, naming what
 * it does reach. Apply reads every issue of the batch once, walks from where each one stands, and
 * an issue that moved since the plan fails alone.
 */
export function transitionVerb(
  host: WriteHost,
  clock: WriteClock = systemClock,
): RecipeVerbContribution {
  return {
    id: TRANSITION_VERB_ID,
    kind: 'action',
    arguments: ARGUMENTS,
    writes: [TRANSITION_WRITE],
    plan: (request) => planTransitions(host, request),
    apply: (request) => applyTransitions(host, request, clock),
  };
}

/** Where each row's target, or its workflow, comes from: one value, or a column per row. */
type Source =
  | { readonly kind: 'none' }
  | { readonly kind: 'value'; readonly value: string }
  | { readonly kind: 'column'; readonly column: string };

/** The source a pair of arguments names: `literal=` or `column=`, never both. */
function sourceOf(request: PlanRequest, literal: string, column: string): Source | Diagnostic {
  const value = request.arguments[literal];
  const named = request.arguments[column];
  if (value !== undefined && named !== undefined) {
    return problem(
      `takes ${literal}= or ${column}=, not both; ${literal}= is one value for every row`,
    );
  }
  if (named !== undefined) {
    const found = columnNamed(request.table, String(named).trim());
    if (found === undefined) {
      return problem(`${column}= names '${String(named)}', which is not a column of the table`);
    }
    if (found.type !== 'text') {
      return problem(`${column}= names ${found.name}, a ${found.type} column; name a text column`);
    }
    return { kind: 'column', column: found.name };
  }
  if (value !== undefined) return { kind: 'value', value: String(value).trim() };
  return { kind: 'none' };
}

function cellText(row: Row, column: string): string {
  const value = row.values[column];
  return typeof value === 'string' ? value.trim() : '';
}

function missingWorkflow(section: unknown, name: string): string {
  const known = workflowNames(section);
  return (
    `workflow=${name}, which the workflows of the jira section of .tyto/project.json ` +
    (known.length === 0 ? 'do not hold; it has none' : `do not hold (${known.join(', ')})`)
  );
}

export async function planTransitions(host: WriteHost, request: PlanRequest): Promise<PlanAnswer> {
  const { table } = request;
  const target = sourceOf(request, 'to', 'to-column');
  if ('severity' in target) return planRefused(target);
  if (target.kind === 'none' || (target.kind === 'value' && target.value === '')) {
    return planRefused(
      problem('needs to=, the status to move each issue to, or to-column=, the column holding it'),
    );
  }
  const workflowSource = sourceOf(request, 'workflow', 'workflow-column');
  if ('severity' in workflowSource) return planRefused(workflowSource);
  let fixedWorkflow: Workflow | undefined;
  if (workflowSource.kind === 'value') {
    const read = workflowOf(request.section, workflowSource.value);
    if (!read.ok) return planRefused(verbFailed(read.error, TRANSITION_VERB_ID));
    if (read.value === undefined) {
      return planRefused(
        problem(`names ${missingWorkflow(request.section, workflowSource.value)}`),
      );
    }
    fixedWorkflow = read.value;
  }
  const fromWritten = request.arguments['from-column'];
  const status = columnNamed(table, String(fromWritten ?? 'status').trim());
  if (status === undefined) {
    return planRefused(
      fromWritten === undefined
        ? problem('needs the status column jira.pull answers, to know where each issue starts')
        : problem(
            `from-column= names '${String(fromWritten)}', which is not a column of the table`,
          ),
    );
  }

  const config = await resolveJiraConfig(host, request.section);
  if (!config.ok) return planRefused(verbFailed(config.error, TRANSITION_VERB_ID));

  const workflows = new Map<string, Workflow | undefined>();
  const operations: PlannedOperation[] = [];
  for (const row of table.rows) {
    const to = target.kind === 'value' ? target.value : cellText(row, target.column);
    // An empty target is a row a step before chose not to move: there is nothing to plan.
    if (to === '') continue;
    const key = issueKeyOf(row);
    if (key === undefined) {
      operations.push(
        plannedFailure(
          TRANSITION_WRITE,
          row.key,
          `${row.key} → ${to}`,
          `E_JIRA_PLAN: row ${row.key} names no issue key in its key column or its key`,
        ),
      );
      continue;
    }
    const from = row.values[status.name];
    if (typeof from !== 'string' || from.trim() === '') {
      operations.push(
        plannedFailure(
          TRANSITION_WRITE,
          row.key,
          `${key} → ${to}`,
          `E_JIRA_PLAN: ${key} has no status in the table`,
        ),
      );
      continue;
    }
    if (same(from, to)) continue;
    let workflow = fixedWorkflow;
    const workflowName =
      workflowSource.kind === 'column' ? cellText(row, workflowSource.column) : '';
    if (workflowName !== '') {
      if (!workflows.has(workflowName)) {
        const read = workflowOf(request.section, workflowName);
        if (!read.ok) return planRefused(verbFailed(read.error, TRANSITION_VERB_ID));
        workflows.set(workflowName, read.value);
      }
      workflow = workflows.get(workflowName);
      if (workflow === undefined) {
        operations.push(
          plannedFailure(
            TRANSITION_WRITE,
            row.key,
            `${key}: ${from} → ${to}`,
            `E_JIRA_CONFIG: ${key} names ${missingWorkflow(request.section, workflowName)}`,
          ),
        );
        continue;
      }
    }
    let path: readonly string[] = [to];
    if (workflow !== undefined) {
      const found = shortestPath(workflow, from, to);
      if (!found.found) {
        operations.push(
          plannedFailure(
            TRANSITION_WRITE,
            row.key,
            `${key}: ${from} → ${to}`,
            unreachable(workflow.name, from, to, found.reached),
          ),
        );
        continue;
      }
      path = found.path;
    }
    const payload: Payload = {
      k: key,
      f: from,
      p: path,
      ...(workflow === undefined ? {} : { w: workflow.name }),
    };
    operations.push(
      plannedOperation(
        TRANSITION_WRITE,
        row.key,
        `${key}: ${[from, ...path].join(' → ')}`,
        payload,
      ),
    );
  }
  return planOf(`Jira ${new URL(config.value.baseUrl).hostname}`, operations);
}

function unreachable(workflow: string, from: string, to: string, reached: readonly string[]) {
  const tried =
    reached.length === 0
      ? `${from} has no transition in it`
      : `the paths tried from ${from} reach only ${reached.slice(0, REACHED_NAMED).join(', ')}` +
        (reached.length > REACHED_NAMED ? ` and ${reached.length - REACHED_NAMED} more` : '');
  return `E_JIRA_CONFIG: workflow ${workflow} has no path from ${from} to ${to}; ${tried}`;
}

interface PlannedTransition {
  readonly k: string;
  /** The status the table read when the plan was made. */
  readonly f: string;
  /** The statuses to walk through, the target last. */
  readonly p: readonly string[];
}

export function applyTransitions(
  host: WriteHost,
  request: ApplyRequest,
  clock: WriteClock = systemClock,
): Promise<ApplyAnswer> {
  return applyBatch(host, request, { decode, write: walk }, clock);
}

function decode(payload: Payload): PlannedTransition | undefined {
  const { k, f, p } = payload;
  if (typeof k !== 'string' || typeof f !== 'string' || !Array.isArray(p) || p.length === 0) {
    return undefined;
  }
  if (!p.every((step): step is string => typeof step === 'string')) return undefined;
  return { k, f, p };
}

/**
 * Walks one issue from where it stands. Where it stands decides: the planned start walks the
 * whole path, a status on the path resumes after it, the target writes nothing, and anything
 * else is a move nobody planned for.
 */
async function walk(
  planned: PlannedTransition,
  issue: CurrentIssue,
  context: WriteContext,
): Promise<AppliedBatchOperation> {
  const { k: key, f: from, p: path } = planned;
  const target = path[path.length - 1] as string;
  if (same(issue.status, target)) {
    return { status: 'applied', reason: `already ${issue.status ?? target}; nothing written` };
  }
  let start: number;
  if (same(issue.status, from)) {
    start = 0;
  } else {
    const at = path.findIndex((step) => same(step, issue.status));
    if (at < 0) {
      return {
        status: 'failed',
        reason:
          `E_JIRA_MOVED: ${key} moved from ${from} to ${issue.status ?? 'no status'} since the ` +
          'plan; run the cell again',
      };
    }
    start = at + 1;
  }

  const walked: string[] = [];
  const startedAt = issue.status ?? from;
  const sofar = (): string =>
    walked.length === 0 ? '' : `; walked ${[startedAt, ...walked].join(' → ')} before this`;
  for (const step of path.slice(start)) {
    const offered = await transitionsOf(context.client, key);
    if (!offered.ok) return failedWith(offered.error, sofar());
    const matches = offered.value.filter((transition) => same(transition.to, step));
    const only = matches[0];
    if (matches.length !== 1 || only === undefined) {
      const at = issue.status ?? 'its status';
      const reason =
        matches.length === 0
          ? `E_JIRA_TRANSITION: ${key} offers no transition from ${at} to ${step}; it offers ` +
            (offered.value.length === 0 ? 'none' : offered.value.map(named).join(', '))
          : `E_JIRA_TRANSITION: ${key} offers ${matches.length} transitions from ${at} to ` +
            `${step}, ${matches.map(named).join(', ')}, and cannot tell which is meant`;
      return { status: 'failed', reason: `${reason}${sofar()}` };
    }
    const endpoint = transitionsPath(key);
    const posted = await context.client.post(endpoint, { transition: { id: only.id } });
    if (!posted.ok) return failedWith(posted.error, sofar());
    issue.status = only.to;
    walked.push(only.to);
  }
  const resumed = start === 0 ? '' : ` (resumed at ${startedAt})`;
  return { status: 'applied', reason: `walked ${[startedAt, ...walked].join(' → ')}${resumed}` };
}

interface OfferedTransition {
  readonly id: string;
  readonly name: string;
  /** The status it leads to. */
  readonly to: string;
}

function transitionsPath(key: string): string {
  return `/rest/api/3/issue/${encodeURIComponent(key)}/transitions`;
}

/** The transitions the issue offers now, from its current status, to the account. */
async function transitionsOf(
  client: JiraClient,
  key: string,
): Promise<JiraResult<readonly OfferedTransition[]>> {
  const path = transitionsPath(key);
  const answer = await client.get(path);
  if (!answer.ok) return answer;
  const listed = record(answer.value)?.['transitions'];
  if (!Array.isArray(listed)) {
    return jiraError('E_JIRA_RESPONSE', `GET ${path} answered no transitions list.`);
  }
  const offered: OfferedTransition[] = [];
  for (const each of listed) {
    const transition = record(each);
    const id = transition?.['id'];
    const name = transition?.['name'];
    const to = record(transition?.['to'])?.['name'];
    if (typeof id !== 'string' || typeof to !== 'string') {
      return jiraError(
        'E_JIRA_RESPONSE',
        `GET ${path} answered a transition without an id or a status.`,
      );
    }
    offered.push({ id, name: typeof name === 'string' ? name : to, to });
  }
  return jiraOk(offered);
}

function named(transition: OfferedTransition): string {
  return `${transition.name} (to ${transition.to})`;
}

function problem(text: string) {
  return argumentsProblem(text, TRANSITION_VERB_ID);
}
