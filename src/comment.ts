import type { AppliedBatchOperation, ApplyRequest, RecipeVerbContribution } from '@tyto/plugin-api';

import { record } from './columns.js';
import { resolveJiraConfig } from './config.js';
import { fingerprint } from './cursor.js';
import {
  COMMENT_VERB_ID,
  argumentsProblem,
  verbFailed,
  type ApplyAnswer,
  type ArgumentSpec,
  type PlanAnswer,
  type PlannedOperation,
  type PlanRequest,
} from './diagnostics.js';
import { textOf } from './fields.js';
import { textToAdf } from './write/adf.js';
import {
  applyBatch,
  failedWith,
  systemClock,
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
  shortened,
  type Payload,
} from './write/plan.js';

export const COMMENT_WRITE = 'comment';

/**
 * The longest comment a plan carries, in UTF-8 bytes: the text rides in the payload, which a
 * plan keeps under 2,048 bytes per row (ADR 0170), and Apply never sees the table.
 */
export const MAX_COMMENT_BYTES = 1500;
/** The comments Apply reads before posting, newest first, looking for one it already left. */
export const RECENT_COMMENTS = 50;

const ARGUMENTS: readonly ArgumentSpec[] = [{ name: 'body', type: 'text', required: true }];

/**
 * `jira.comment body=<column>`: adds the row's text as a comment on its issue, through
 * `POST /issue/{key}/comment`, with blank lines as paragraphs and addresses as links.
 *
 * Applying twice comments once: before posting, Apply reads the issue's last fifty comments,
 * and one this account left with the same text answers `applied` with nothing written.
 */
export function commentVerb(
  host: WriteHost,
  clock: WriteClock = systemClock,
): RecipeVerbContribution {
  return {
    id: COMMENT_VERB_ID,
    kind: 'action',
    arguments: ARGUMENTS,
    writes: [COMMENT_WRITE],
    plan: (request) => planComments(host, request),
    apply: (request) => applyComments(host, request, clock),
  };
}

export async function planComments(host: WriteHost, request: PlanRequest): Promise<PlanAnswer> {
  const { table } = request;
  const written = String(request.arguments['body'] ?? '').trim();
  const column = columnNamed(table, written);
  if (column === undefined) {
    return planRefused(problem(`body= names '${written}', which is not a column of the table`));
  }
  if (column.type !== 'text') {
    return planRefused(
      problem(`body= names ${column.name}, a ${column.type} column; a comment is text`),
    );
  }
  const config = await resolveJiraConfig(host, request.section);
  if (!config.ok) return planRefused(verbFailed(config.error, COMMENT_VERB_ID));

  const operations: PlannedOperation[] = [];
  for (const row of table.rows) {
    const key = issueKeyOf(row);
    const fail = (reason: string): void => {
      operations.push(plannedFailure(COMMENT_WRITE, row.key, `${key ?? row.key}: comment`, reason));
    };
    if (key === undefined) {
      fail(`E_JIRA_PLAN: row ${row.key} names no issue key in its key column or its key`);
      continue;
    }
    const value = row.values[column.name];
    const text = typeof value === 'string' ? value.trim() : '';
    if (text === '') {
      fail(`E_JIRA_PLAN: ${key} has no text in ${column.name}`);
      continue;
    }
    const bytes = new TextEncoder().encode(text).byteLength;
    if (bytes > MAX_COMMENT_BYTES) {
      fail(
        `E_JIRA_PLAN: ${key}'s comment is ${bytes.toLocaleString('en-US')} bytes, over the ` +
          `${MAX_COMMENT_BYTES.toLocaleString('en-US')} a plan carries; shorten it`,
      );
      continue;
    }
    const preview = shortened(text.replace(/\s+/g, ' '), 80);
    operations.push(
      plannedOperation(COMMENT_WRITE, row.key, `${key}: comment "${preview}"`, { k: key, b: text }),
    );
  }
  return planOf(`Jira ${new URL(config.value.baseUrl).hostname}`, operations);
}

interface PlannedComment {
  readonly k: string;
  readonly b: string;
}

export function applyComments(
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
      async write(planned, _issue, context) {
        if (me === undefined) {
          const account = await context.client.myself();
          if (!account.ok) return failedWith(account.error);
          me = account.value.accountId;
        }
        return comment(planned, me, context);
      },
    },
    clock,
  );
}

function decode(payload: Payload): PlannedComment | undefined {
  const { k, b } = payload;
  return typeof k === 'string' && typeof b === 'string' ? { k, b } : undefined;
}

async function comment(
  planned: PlannedComment,
  me: string,
  context: WriteContext,
): Promise<AppliedBatchOperation> {
  const path = `/rest/api/3/issue/${encodeURIComponent(planned.k)}/comment`;
  const body = textToAdf(planned.b);
  const wanted = fingerprint(textOf(body));
  const recent = await context.client.get(path, {
    orderBy: '-created',
    maxResults: RECENT_COMMENTS,
  });
  if (!recent.ok) return failedWith(recent.error);
  const comments = record(recent.value)?.['comments'];
  const left = (Array.isArray(comments) ? comments : []).some((each) => {
    const existing = record(each);
    return (
      record(existing?.['author'])?.['accountId'] === me &&
      fingerprint(textOf(existing?.['body'] ?? '')) === wanted
    );
  });
  if (left) return { status: 'applied', reason: 'already commented; nothing written' };
  const posted = await context.client.post(path, { body });
  if (!posted.ok) return failedWith(posted.error);
  return { status: 'applied' };
}

function problem(text: string) {
  return argumentsProblem(text, COMMENT_VERB_ID);
}
