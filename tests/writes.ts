import type { FetchedResponse } from '@tyto/plugin-api';
import type { TestRecipeOptions } from '@tyto/plugin-api/testing';

import { response } from './host.js';
import type { FakeSite, JiraCall, Route } from './jira.js';

/**
 * A synthetic Jira that writes: issues with a status and an assignee, a workflow of named
 * transitions, and the four endpoints the write verbs call. Nothing here is a real site, key,
 * workflow or person.
 */
export type InputTable = NonNullable<TestRecipeOptions['input']>;

export interface FakeIssue {
  status: string;
  assignee: { accountId: string; displayName: string } | null;
}

/** By status: the transitions Jira offers from it, as `[id, name, to]`. */
export type Transitions = Readonly<Record<string, readonly (readonly [string, string, string])[]>>;

export const SEARCH = '/rest/api/3/search/jql';
export const ME = { accountId: '557058:00000000-0000-4000-8000-000000000001', displayName: 'Me' };

/** Answers every write call from `issues`, which it changes as Jira would. */
export function jiraWrites(issues: Map<string, FakeIssue>, transitions: Transitions = {}): Route {
  return (call: JiraCall): FetchedResponse | undefined => {
    if (call.method === 'POST' && call.path === SEARCH) {
      const jql = (call.body as { jql: string }).jql;
      const keys = /^key in \(([^)]*)\)$/.exec(jql)?.[1]?.split(', ') ?? [];
      const found = keys.flatMap((key) => {
        const issue = issues.get(key);
        if (issue === undefined) return [];
        return [
          {
            id: key.replace(/\D/g, ''),
            key,
            fields: {
              status: { name: issue.status },
              assignee: issue.assignee,
              updated: '2026-11-01T00:00:00.000+0000',
            },
          },
        ];
      });
      return response(200, { issues: found, isLast: true });
    }
    if (call.method === 'GET' && call.path === '/rest/api/3/myself') return response(200, ME);
    const match = /^\/rest\/api\/3\/issue\/([^/]+)\/(transitions|assignee)$/.exec(call.path);
    const key = match?.[1] === undefined ? undefined : decodeURIComponent(match[1]);
    const issue = key === undefined ? undefined : issues.get(key);
    if (match === null || issue === undefined) return undefined;
    const offered = transitions[issue.status] ?? [];
    if (match[2] === 'transitions' && call.method === 'GET') {
      return response(200, {
        transitions: offered.map(([id, name, to]) => ({ id, name, to: { name: to } })),
      });
    }
    if (match[2] === 'transitions' && call.method === 'POST') {
      const id = (call.body as { transition: { id: string } }).transition.id;
      const chosen = offered.find(([each]) => each === id);
      if (chosen === undefined) return response(400, { errorMessages: ['no such transition'] });
      issue.status = chosen[2];
      return response(204);
    }
    if (match[2] === 'assignee' && call.method === 'PUT') {
      const accountId = (call.body as { accountId: string | null }).accountId;
      issue.assignee =
        accountId === null ? null : { accountId, displayName: `Person ${accountId.slice(-4)}` };
      return response(204);
    }
    return undefined;
  };
}

/** A table as `jira.pull` answers it, cut to the columns a write reads. */
export function pulled(
  rows: readonly (readonly [key: string, status: string | null, assignee?: string | null])[],
  extra: InputTable['columns'] = [],
  values: Readonly<Record<string, Readonly<Record<string, string | null>>>> = {},
): InputTable {
  return {
    columns: [
      { name: 'key', type: 'text', origin: 'jira' },
      { name: 'status', type: 'text', origin: 'jira' },
      { name: 'assignee', type: 'text', origin: 'jira' },
      ...extra,
    ],
    rows: rows.map(([key, status, assignee = null]) => ({
      key,
      values: { key, status, assignee, ...values[key] },
      provenance: { source: 'jira', id: key, fetchedAt: '2026-11-01T00:00:00.000Z' },
    })),
  };
}

/** Runs one action step over `input` and applies its plan, as the notebook's Apply does. */
export async function planAndApply(
  site: FakeSite,
  step: string,
  input: InputTable,
  between: () => void = () => {},
) {
  const ran = await site.plugin.runRecipe(step, { input });
  if (!ran.ok) throw new Error(ran.error.map((item) => item.message).join('\n'));
  const cell = ran.value.cells.at(-1);
  const diagnostics = (cell?.diagnostics ?? []).map(({ code, message }) => ({ code, message }));
  const plan = cell?.plan;
  if (plan === undefined) return { diagnostics, plan, applied: undefined, planCalls: 0 };
  const planCalls = site.calls.length;
  between();
  const verb = site.plugin.recipes.verbs.get(step.split(' ')[0] ?? '');
  if (verb?.apply === undefined) throw new Error(`${step} has no apply`);
  const applied = await verb.apply(plan);
  if (!applied.ok) throw new Error(applied.error.map((item) => item.message).join('\n'));
  // The host's own fields (the row from the shown plan, the time from its clock) are its test's.
  const operations = applied.value.operations.map(({ status, reason }) => ({
    status,
    ...(reason === undefined ? {} : { reason }),
  }));
  return { diagnostics, plan, applied: operations, planCalls };
}

/** The calls Apply made, as `METHOD path`. */
export function callsAfter(site: FakeSite, start: number): string[] {
  return site.calls.slice(start).map((call) => `${call.method} ${call.path}`);
}
