import type {
  Diagnostic,
  JsonValue,
  Plan,
  PlanAnswer,
  PlannedOperation,
  Row,
  Table,
} from '../diagnostics.js';
import { ISSUE_KEY } from '../pull.js';

/**
 * The plan's ceilings, as `@tyto/recipe`'s `PLAN_LIMITS` holds them (ADR 0135, ADR 0170).
 * Written here rather than imported: the bundle imports nothing, and a value import of the
 * contract would carry the whole of it into `dist/index.js`.
 */
export const MAX_DESCRIPTION_LENGTH = 500;
export const MAX_PAYLOAD_BYTES = 2048;

/** A payload as this plugin writes it: an object of short keys. */
export type Payload = Readonly<Record<string, JsonValue>>;

/**
 * One operation of a plan. Past the payload ceiling the host would refuse the whole plan, so
 * the operation becomes a planned failure instead: the row shows why, and the others apply.
 */
export function plannedOperation(
  write: string,
  rowKey: string,
  description: string,
  payload: Payload,
): PlannedOperation {
  const bytes = payloadBytes(payload);
  if (bytes > MAX_PAYLOAD_BYTES) {
    const key = typeof payload['k'] === 'string' ? `${payload['k']}: ` : '';
    return plannedFailure(
      write,
      rowKey,
      description,
      `E_JIRA_PLAN: ${key}this write needs ${bytes.toLocaleString('en-US')} bytes to be kept ` +
        `with the plan, over the ${MAX_PAYLOAD_BYTES.toLocaleString('en-US')} a plan keeps per row; ` +
        'shorten what it writes',
    );
  }
  return { write, rowKey, description: shortened(description), payload };
}

/**
 * A row the plan already knows cannot be applied. Shown with the others, and answered `failed`
 * on Apply with this reason and no request: the person reads it before confirming.
 */
export function plannedFailure(
  write: string,
  rowKey: string,
  description: string,
  reason: string,
): PlannedOperation {
  return {
    write,
    rowKey,
    description: shortened(`${description} (will fail: ${reason})`),
    payload: { x: shortened(reason) },
  };
}

/** The issue a row stands for: its `key` column when that holds an issue key, else its key. */
export function issueKeyOf(row: Row): string | undefined {
  for (const candidate of [row.values['key'], row.key]) {
    const key = typeof candidate === 'string' ? candidate.trim() : undefined;
    if (key !== undefined && ISSUE_KEY.test(key)) return key;
  }
  return undefined;
}

/** The table's column of that name, as `where` finds one: ignoring case. */
export function columnNamed(table: Table, name: string): Table['columns'][number] | undefined {
  const wanted = name.toLowerCase();
  return table.columns.find((column) => column.name.toLowerCase() === wanted);
}

export function planOf(target: string, operations: readonly PlannedOperation[]): PlanAnswer {
  const plan: Plan = { target, operations, count: operations.length };
  return { ok: true, value: plan, diagnostics: [] };
}

export function planRefused(diagnostic: Diagnostic): PlanAnswer {
  return { ok: false, error: [diagnostic] };
}

/** The UTF-8 bytes of the payload as JSON, which is how the ceiling counts it. */
export function payloadBytes(payload: JsonValue): number {
  return new TextEncoder().encode(JSON.stringify(payload)).byteLength;
}

/** At most the ceiling a description and a reason share, cut with an ellipsis. */
export function shortened(text: string, limit: number = MAX_DESCRIPTION_LENGTH): string {
  return text.length <= limit ? text : `${text.slice(0, limit - 1)}…`;
}
