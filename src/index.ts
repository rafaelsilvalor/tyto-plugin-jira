import type { Disposable, PluginHost } from '@tyto/plugin-api';

import { assignVerb } from './assign.js';
import { pullVerb } from './pull.js';
import { refreshVerb } from './refresh.js';
import { SETTINGS } from './settings.js';
import { transitionVerb } from './transition.js';

/**
 * Declares the plugin's settings and its recipe verbs: the `jira.pull` source, the
 * `jira.refresh` transform, and the `jira.transition` and `jira.assign` actions, which plan
 * and write only when a person applies the plan.
 *
 * Nothing is read at activation: the site, the email and the token are resolved on every call
 * of a verb, from the section the call carries, so a folder or a credential changed between
 * two runs is what the next run uses.
 */
export function activate(host: PluginHost): Disposable {
  const registered = [
    ...SETTINGS.map((setting) => host.registerConfiguration(setting)),
    host.registerRecipeVerb(pullVerb(host)),
    host.registerRecipeVerb(refreshVerb(host)),
    host.registerRecipeVerb(transitionVerb(host)),
    host.registerRecipeVerb(assignVerb(host)),
  ];
  return {
    dispose() {
      for (const registration of registered) registration.dispose();
    },
  };
}
