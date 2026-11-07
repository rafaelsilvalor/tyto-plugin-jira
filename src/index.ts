import type { Disposable, PluginHost } from '@tyto/plugin-api';

import { pullVerb } from './pull.js';
import { SETTINGS } from './settings.js';

/**
 * Declares the plugin's settings and its one recipe verb, `jira.pull`.
 *
 * Nothing is read at activation: the site, the email and the token are resolved on every call
 * of the verb, from the section the call carries, so a folder or a credential changed between
 * two runs is what the next run uses.
 */
export function activate(host: PluginHost): Disposable {
  const registered = [
    ...SETTINGS.map((setting) => host.registerConfiguration(setting)),
    host.registerRecipeVerb(pullVerb(host)),
  ];
  return {
    dispose() {
      for (const registration of registered) registration.dispose();
    },
  };
}
