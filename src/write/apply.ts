import type { AppliedBatchOperation, ApplyRequest, PluginHost } from '@tyto/plugin-api';

import { record } from '../columns.js';
import { resolveJiraConfig, type JiraConfig } from '../config.js';
import type { ApplyAnswer, JsonValue } from '../diagnostics.js';
import {
  describeJiraError,
  jiraError,
  jiraOk,
  type JiraError,
  type JiraResult,
} from '../errors.js';
import { createJiraClient, type JiraClient } from '../http.js';
import { searchPage } from '../search.js';
import { shortened, type Payload } from './plan.js';

/** The parts of the host a write uses. */
export type WriteHost = Pick<PluginHost, 'config' | 'credentials' | 'fetch'>;

/** The time an Apply measures its budget by; a test passes one it moves. */
export interface WriteClock {
  now(): number;
  sleep?(milliseconds: number): Promise<void>;
}

export const systemClock: WriteClock = { now: () => Date.now() };

/**
 * How long one `apply` call writes, under the host's 30 s deadline for the call: the operation
 * running when it ends may still need a few requests to finish.
 */
export const APPLY_BUDGET_MILLISECONDS = 20_000;
/** The reason of every operation the budget left unreached. */
export const NOT_REACHED = "not reached in this call's time; run the cell and Apply again";

/** What the batch's one search read of each issue, before any write. */
export interface CurrentIssue {
  readonly key: string;
  status: string | null;
  assignee: { readonly accountId: string; readonly displayName: string | null } | null;
  readonly updated: string | null;
}

/** What one operation is handed besides its payload. */
export interface WriteContext {
  readonly client: JiraClient;
  readonly config: JiraConfig;
  /** By issue key, as the batch's search read it; an operation updates what it wrote. */
  readonly current: ReadonlyMap<string, CurrentIssue>;
}

export interface WriteVerb<Decoded extends { readonly k: string }> {
  /** The payload as this verb planned it, or `undefined` when it is not one. */
  decode(payload: Payload): Decoded | undefined;
  /** Writes one operation; the issue was found by the batch's search. */
  write(
    decoded: Decoded,
    issue: CurrentIssue,
    context: WriteContext,
  ): Promise<AppliedBatchOperation>;
}

/** Keys per drift search: a whole batch, so one search per call. */
const DRIFT_FIELDS = ['status', 'assignee', 'updated'] as const;

/**
 * One batch of a plan, as ADR 0170 hands it: each operation in order, answered `applied`,
 * `failed` with a reason that starts with the plugin's code, or `skipped` when the call's
 * budget ran out first.
 *
 * Before any write, one search reads every issue of the batch (`key in (...)`), so each
 * operation compares what it planned from with what Jira holds now and fails alone when the
 * issue moved. After Jira refuses the token, no other request is made: the remaining
 * operations fail with the same reason. **No reason carries the token.**
 */
export async function applyBatch<Decoded extends { readonly k: string }>(
  host: WriteHost,
  request: ApplyRequest,
  verb: WriteVerb<Decoded>,
  clock: WriteClock = systemClock,
): Promise<ApplyAnswer> {
  const { operations } = request;
  const config = await resolveJiraConfig(host, request.section);
  if (!config.ok) return answered(operations.map(() => failedWith(config.error)));
  const redact = (text: string): string =>
    config.value.token === '' ? text : text.split(config.value.token).join('[redacted]');
  const finished = (outcome: AppliedBatchOperation): AppliedBatchOperation =>
    outcome.reason === undefined
      ? outcome
      : { ...outcome, reason: shortened(redact(outcome.reason)) };

  const deadline = clock.now() + APPLY_BUDGET_MILLISECONDS;
  let outOfTime = false;
  const client = createJiraClient({
    config: config.value,
    fetch: (url, init) => {
      if (outOfTime || clock.now() > deadline) {
        outOfTime = true;
        return Promise.reject(new Error(NOT_REACHED));
      }
      return host.fetch(url, init);
    },
    sleep: async (milliseconds) => {
      if (clock.now() + milliseconds > deadline) outOfTime = true;
      else await (clock.sleep ?? wait)(milliseconds);
    },
  });

  const decoded = operations.map((operation) => decodeOperation(operation.payload, verb));
  const keys = [
    ...new Set(
      decoded.flatMap((each) => (typeof each === 'object' && 'k' in each ? [each.k] : [])),
    ),
  ];
  const read = keys.length === 0 ? jiraOk(new Map()) : await currentIssues(client, keys);
  const context: WriteContext | undefined = read.ok
    ? { client, config: config.value, current: read.value }
    : undefined;

  let refused: string | undefined;
  const outcomes: AppliedBatchOperation[] = [];
  for (const each of decoded) {
    if (typeof each === 'string') {
      outcomes.push(finished({ status: 'failed', reason: each }));
      continue;
    }
    if (!read.ok) {
      outcomes.push(finished(failedWith(read.error)));
      continue;
    }
    if (outOfTime || clock.now() > deadline) {
      outOfTime = true;
      outcomes.push({ status: 'skipped', reason: NOT_REACHED });
      continue;
    }
    if (refused !== undefined) {
      outcomes.push(finished({ status: 'failed', reason: refused }));
      continue;
    }
    const issue = context?.current.get(each.k);
    if (issue === undefined || context === undefined) {
      outcomes.push(
        finished({
          status: 'failed',
          reason:
            `E_JIRA_MOVED: ${each.k} was not found; it may have been deleted, moved to another ` +
            'project or hidden from this account since the plan',
        }),
      );
      continue;
    }
    const outcome = finished(await verb.write(each, issue, context));
    if (outcome.status === 'failed' && outcome.reason?.startsWith('E_JIRA_AUTH') === true) {
      refused = outcome.reason;
    }
    outcomes.push(outcome);
  }
  return answered(outcomes);
}

/** A planned failure's reason, a payload this verb reads, or why it reads none. */
function decodeOperation<Decoded>(
  payload: JsonValue | undefined,
  verb: WriteVerb<Decoded & { readonly k: string }>,
): (Decoded & { readonly k: string }) | string {
  const object = record(payload) as Payload | undefined;
  if (object === undefined) return UNREADABLE;
  const planned = object['x'];
  if (typeof planned === 'string') return planned;
  return verb.decode(object) ?? UNREADABLE;
}

const UNREADABLE =
  'E_JIRA_PLAN: this operation carries no payload this version of the plugin reads; run the ' +
  'cell again';

/** Every issue of the batch as Jira holds it now, by key, in one search. */
async function currentIssues(
  client: JiraClient,
  keys: readonly string[],
): Promise<JiraResult<Map<string, CurrentIssue>>> {
  const found = new Map<string, CurrentIssue>();
  const jql = `key in (${keys.join(', ')})`;
  let token: string | undefined;
  for (;;) {
    const page = await searchPage(client, jql, DRIFT_FIELDS, token);
    if (!page.ok) return page;
    for (const issue of page.value.issues) {
      const status = record(issue.fields['status'])?.['name'];
      const assignee = record(issue.fields['assignee']);
      const accountId = assignee?.['accountId'];
      const displayName = assignee?.['displayName'];
      const updated = issue.fields['updated'];
      found.set(issue.key, {
        key: issue.key,
        status: typeof status === 'string' ? status : null,
        assignee:
          typeof accountId === 'string'
            ? { accountId, displayName: typeof displayName === 'string' ? displayName : null }
            : null,
        updated: typeof updated === 'string' ? updated : null,
      });
    }
    const next = page.value.nextPageToken;
    if (page.value.isLast || next === undefined) return jiraOk(found);
    if (next === token) {
      return jiraError(
        'E_JIRA_RESPONSE',
        'the search for the batch answered the token it was given.',
      );
    }
    token = next;
  }
}

export function failedWith(error: JiraError, suffix = ''): AppliedBatchOperation {
  return { status: 'failed', reason: `${describeJiraError(error)}${suffix}` };
}

function answered(operations: readonly AppliedBatchOperation[]): ApplyAnswer {
  return { ok: true, value: { operations }, diagnostics: [] };
}

/** Two status or account names as Jira compares them: without case or surrounding blanks. */
export function same(left: string | null | undefined, right: string | null | undefined): boolean {
  return (left ?? '').trim().toLowerCase() === (right ?? '').trim().toLowerCase();
}

const wait = (milliseconds: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, milliseconds));
