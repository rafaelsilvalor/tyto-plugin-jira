import type { AppliedBatchOperation, ApplyRequest, RecipeVerbContribution } from '@tyto/plugin-api';

import { resolveJiraConfig } from './config.js';
import {
  ASSIGN_VERB_ID,
  argumentsProblem,
  verbFailed,
  type ApplyAnswer,
  type ArgumentSpec,
  type Column,
  type PlanAnswer,
  type PlannedOperation,
  type PlanRequest,
} from './diagnostics.js';
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

export const ASSIGN_WRITE = 'assign';

const ARGUMENTS: readonly ArgumentSpec[] = [{ name: 'to', type: 'text', required: true }];

/**
 * Jira Cloud's account ids: `557058:` and a UUID, or 24 hexadecimal digits, among others. The
 * plugin checks only that the text could be one, so a name or an email is caught at the plan.
 */
const ACCOUNT_ID = /^[A-Za-z0-9][A-Za-z0-9:_-]{0,127}$/;

/**
 * `jira.assign to=<column>|me|none`: assigns each row's issue to the account id its `to=`
 * column holds, to the token's own account, or to nobody, through `PUT /issue/{key}/assignee`.
 *
 * No lookup by name or email: a recipe that knows a person knows their account id, and a
 * lookup that guesses between two people with one name would write to the wrong one. When the
 * table holds `jira.pull`'s `assignee` column, Apply checks the issue is still assigned to the
 * person it read, and an issue reassigned since the plan fails alone.
 */
export function assignVerb(
  host: WriteHost,
  clock: WriteClock = systemClock,
): RecipeVerbContribution {
  return {
    id: ASSIGN_VERB_ID,
    kind: 'action',
    arguments: ARGUMENTS,
    writes: [ASSIGN_WRITE],
    plan: (request) => planAssignments(host, request),
    apply: (request) => applyAssignments(host, request, clock),
  };
}

type Target =
  | { readonly kind: 'me' }
  | { readonly kind: 'none' }
  | { readonly kind: 'column'; readonly column: Column };

export async function planAssignments(host: WriteHost, request: PlanRequest): Promise<PlanAnswer> {
  const { table } = request;
  const written = String(request.arguments['to'] ?? '').trim();
  let target: Target;
  if (written.toLowerCase() === 'me') target = { kind: 'me' };
  else if (written.toLowerCase() === 'none') target = { kind: 'none' };
  else {
    const column = columnNamed(table, written);
    if (column === undefined) {
      return planRefused(
        problem(
          `to= names '${written}', which is neither me, none nor a column of the table holding ` +
            'account ids',
        ),
      );
    }
    if (column.type !== 'text') {
      return planRefused(
        problem(`to= names ${column.name}, a ${column.type} column; an account id is text`),
      );
    }
    target = { kind: 'column', column };
  }
  const assignee = columnNamed(table, 'assignee');

  const config = await resolveJiraConfig(host, request.section);
  if (!config.ok) return planRefused(verbFailed(config.error, ASSIGN_VERB_ID));

  const operations: PlannedOperation[] = [];
  for (const row of table.rows) {
    const key = issueKeyOf(row) ?? row.key;
    const fail = (description: string, reason: string): void => {
      operations.push(plannedFailure(ASSIGN_WRITE, row.key, description, reason));
    };
    if (issueKeyOf(row) === undefined) {
      fail(
        `${row.key}: assign`,
        `E_JIRA_PLAN: row ${row.key} names no issue key in its key column or its key`,
      );
      continue;
    }
    const from = assignee === undefined ? undefined : row.values[assignee.name];
    const drift: Payload =
      assignee === undefined
        ? {}
        : { f: typeof from === 'string' && from.trim() !== '' ? from : null };
    const before = typeof from === 'string' && from.trim() !== '' ? `${from} → ` : '';
    if (target.kind === 'me') {
      operations.push(
        plannedOperation(ASSIGN_WRITE, row.key, `${key}: ${before}the token's own account`, {
          k: key,
          ...drift,
          me: true,
        }),
      );
      continue;
    }
    if (target.kind === 'none') {
      operations.push(
        plannedOperation(ASSIGN_WRITE, row.key, `${key}: ${before}unassigned`, {
          k: key,
          ...drift,
          t: null,
        }),
      );
      continue;
    }
    const value = row.values[target.column.name];
    const accountId = typeof value === 'string' ? value.trim() : '';
    if (accountId === '') {
      fail(`${key}: assign`, `E_JIRA_PLAN: ${key} has no account id in ${target.column.name}`);
      continue;
    }
    if (!ACCOUNT_ID.test(accountId)) {
      fail(
        `${key}: assign`,
        `E_JIRA_PLAN: ${JSON.stringify(accountId.slice(0, 80))} in ${target.column.name} is not ` +
          'a Jira account id; write the id, not a name or an email',
      );
      continue;
    }
    operations.push(
      plannedOperation(ASSIGN_WRITE, row.key, `${key}: ${before}${accountId}`, {
        k: key,
        ...drift,
        t: accountId,
      }),
    );
  }
  return planOf(`Jira ${new URL(config.value.baseUrl).hostname}`, operations);
}

interface PlannedAssignment {
  readonly k: string;
  /** The assignee's display name the table read; absent when the table had no such column. */
  readonly f?: string | null;
  /** The account id, `null` for nobody; absent with `me`. */
  readonly t?: string | null;
  readonly me?: true;
}

export function applyAssignments(
  host: WriteHost,
  request: ApplyRequest,
  clock: WriteClock = systemClock,
): Promise<ApplyAnswer> {
  let me: string | undefined;
  return applyBatch(
    host,
    request,
    {
      decode,
      async write(planned, issue, context) {
        if (planned.me === true && me === undefined) {
          const account = await context.client.myself();
          if (!account.ok) return failedWith(account.error);
          me = account.value.accountId;
        }
        return assign(
          planned,
          planned.me === true ? (me as string) : (planned.t ?? null),
          issue,
          context,
        );
      },
    },
    clock,
  );
}

function decode(payload: Payload): PlannedAssignment | undefined {
  const { k, f, t, me } = payload;
  if (typeof k !== 'string') return undefined;
  if (f !== undefined && f !== null && typeof f !== 'string') return undefined;
  const drift = f === undefined ? {} : { f };
  if (me === true) return { k, ...drift, me: true };
  if (t === null || typeof t === 'string') return { k, ...drift, t };
  return undefined;
}

async function assign(
  planned: PlannedAssignment,
  accountId: string | null,
  issue: CurrentIssue,
  context: WriteContext,
): Promise<AppliedBatchOperation> {
  const key = planned.k;
  const now = issue.assignee;
  if (now?.accountId === accountId || (now === null && accountId === null)) {
    return {
      status: 'applied',
      reason: `already ${accountId === null ? 'unassigned' : `assigned to ${now?.displayName ?? accountId}`}; nothing written`,
    };
  }
  if (planned.f !== undefined && !same(now?.displayName ?? null, planned.f)) {
    return {
      status: 'failed',
      reason:
        `E_JIRA_MOVED: ${key} was assigned to ${planned.f ?? 'nobody'} when planned and is ` +
        `assigned to ${now?.displayName ?? 'nobody'} now; run the cell again`,
    };
  }
  const path = `/rest/api/3/issue/${encodeURIComponent(key)}/assignee`;
  const put = await context.client.put(path, { accountId });
  if (!put.ok) return failedWith(put.error);
  issue.assignee = accountId === null ? null : { accountId, displayName: null };
  return { status: 'applied' };
}

function problem(text: string) {
  return argumentsProblem(text, ASSIGN_VERB_ID);
}
