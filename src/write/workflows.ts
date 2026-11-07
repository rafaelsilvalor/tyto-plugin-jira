import { record } from '../columns.js';
import { jiraError, jiraOk, type JiraResult } from '../errors.js';

/**
 * One workflow of the `workflows` key of the `jira` section of `.tyto/project.json`:
 * `{"<from>": ["<to>", ...]}`, each status with the statuses one transition reaches from it.
 * Statuses are compared without case, as Jira compares them, and kept as written.
 */
export interface Workflow {
  readonly name: string;
  /** By the status in lower case: its name as written, and where one transition takes it. */
  readonly steps: ReadonlyMap<string, { readonly name: string; readonly next: readonly string[] }>;
}

/**
 * The workflow named `name`, `undefined` when the section names none by that name, or why the
 * `workflows` key is refused. A company's graph lives in its workspace, never in the plugin.
 */
export function workflowOf(section: unknown, name: string): JiraResult<Workflow | undefined> {
  const written = record(section)?.['workflows'];
  if (written === undefined || written === null) return jiraOk(undefined);
  const workflows = record(written);
  if (workflows === undefined) {
    return configError(
      'workflows in the jira section of .tyto/project.json is not an object of workflow ' +
        'names, such as {"delivery": {"To Do": ["In Progress"]}}',
    );
  }
  const entry = Object.entries(workflows).find(([each]) => each === name);
  if (entry === undefined) return jiraOk(undefined);
  const graph = record(entry[1]);
  if (graph === undefined) {
    return configError(
      `workflow ${name} is not an object of statuses, such as {"To Do": ["In Progress"]}`,
    );
  }
  const steps = new Map<string, { name: string; next: string[] }>();
  for (const [from, targets] of Object.entries(graph)) {
    if (
      from.trim() === '' ||
      !Array.isArray(targets) ||
      !targets.every((target) => typeof target === 'string' && target.trim() !== '')
    ) {
      return configError(
        `workflow ${name} maps ${JSON.stringify(from)} to ${JSON.stringify(targets)}; each ` +
          'status maps to a list of status names, such as "To Do": ["In Progress"]',
      );
    }
    const key = from.trim().toLowerCase();
    const known = steps.get(key);
    const next = (targets as string[]).map((target) => target.trim());
    if (known === undefined) steps.set(key, { name: from.trim(), next });
    else known.next.push(...next);
  }
  return jiraOk({ name, steps });
}

/** The workflows the section names, for a message that says which exist. */
export function workflowNames(section: unknown): readonly string[] {
  const workflows = record(record(section)?.['workflows']);
  return workflows === undefined ? [] : Object.keys(workflows);
}

export type PathSearch =
  | { readonly found: true; readonly path: readonly string[] }
  | { readonly found: false; readonly reached: readonly string[] };

/**
 * The shortest walk from `from` to `to`, by breadth first, as the statuses after `from` with
 * `to` last. Without one, the statuses the walk did reach, so a planned failure can name what
 * was tried. Ties go to the order the workflow lists its statuses in.
 */
export function shortestPath(workflow: Workflow, from: string, to: string): PathSearch {
  const start = from.trim().toLowerCase();
  const goal = to.trim().toLowerCase();
  const previous = new Map<string, string | null>([[start, null]]);
  const names = new Map<string, string>([[start, from.trim()]]);
  const queue = [start];
  while (queue.length > 0) {
    const current = queue.shift() as string;
    if (current === goal) {
      const path: string[] = [];
      for (let at: string | null = current; at !== null && at !== start;) {
        path.unshift(names.get(at) ?? at);
        at = previous.get(at) ?? null;
      }
      return { found: true, path };
    }
    for (const next of workflow.steps.get(current)?.next ?? []) {
      const key = next.toLowerCase();
      if (previous.has(key)) continue;
      previous.set(key, current);
      names.set(key, workflow.steps.get(key)?.name ?? next);
      queue.push(key);
    }
  }
  return {
    found: false,
    reached: [...names.entries()].filter(([key]) => key !== start).map(([, name]) => name),
  };
}

function configError<T>(message: string): JiraResult<T> {
  return jiraError('E_JIRA_CONFIG', message);
}
