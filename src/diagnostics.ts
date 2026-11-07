import type { RecipeVerbContribution } from '@tyto/plugin-api';

import { describeJiraError, type JiraError } from './errors.js';

/**
 * The recipe types this plugin answers with, read off the contract's own verb type: the plugin
 * imports only `@tyto/plugin-api`, whose `@tyto/recipe` and `@tyto/core` are not its to name.
 */
type PageFunction = NonNullable<RecipeVerbContribution['page']>;
export type PageRequest = Parameters<PageFunction>[0];
export type PageAnswer = Awaited<ReturnType<PageFunction>>;
export type SourcePage = Extract<PageAnswer, { readonly ok: true }>['value'];
export type Table = SourcePage['table'];
export type Column = Table['columns'][number];
export type Row = Table['rows'][number];
export type CellValue = Row['values'][string];
export type Diagnostic = Extract<PageAnswer, { readonly ok: false }>['error'][number];
export type ArgumentSpec = RecipeVerbContribution['arguments'][number];
export type ArgumentValues = PageRequest['arguments'];

/** What an action plans (ADR 0129) and Apply hands back (ADR 0170), off the same contract. */
type PlanFunction = NonNullable<RecipeVerbContribution['plan']>;
export type PlanRequest = Parameters<PlanFunction>[0];
export type PlanAnswer = Awaited<ReturnType<PlanFunction>>;
export type Plan = Extract<PlanAnswer, { readonly ok: true }>['value'];
export type PlannedOperation = Plan['operations'][number];
export type JsonValue = Exclude<PlannedOperation['payload'], undefined>;
type ApplyFunction = NonNullable<RecipeVerbContribution['apply']>;
export type ApplyAnswer = Awaited<ReturnType<ApplyFunction>>;

export const VERB_ID = 'jira.pull';
export const REFRESH_VERB_ID = 'jira.refresh';
export const TRANSITION_VERB_ID = 'jira.transition';
export const ASSIGN_VERB_ID = 'jira.assign';

/**
 * A Jira failure in Tyto's words. Tyto's catalogue is closed, so the plugin's own code
 * (`E_JIRA_AUTH`, `E_JIRA_CONFIG`…) rides inside `E_RECIPE_VERB`'s message, first, where a bug
 * report carries it.
 */
export function verbFailed(error: JiraError, verb: string = VERB_ID): Diagnostic {
  return {
    severity: 'error',
    code: 'E_RECIPE_VERB',
    message: `'${verb}' failed: ${withoutFinalStop(describeJiraError(error))}.`,
  };
}

/** The step's arguments are of the right types but do not say what to read. */
export function argumentsProblem(problem: string, verb: string = VERB_ID): Diagnostic {
  return {
    severity: 'error',
    code: 'E_RECIPE_ARGUMENTS',
    message: `'${verb}' ${withoutFinalStop(problem)}.`,
  };
}

export function failed(diagnostic: Diagnostic): PageAnswer {
  return { ok: false, error: [diagnostic] };
}

function withoutFinalStop(text: string): string {
  return text.trim().replace(/\.+$/, '');
}
