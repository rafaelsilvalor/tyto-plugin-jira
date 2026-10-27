import { SETTINGS } from './settings.js';
import type { Disposable, PluginHost } from './tyto-api.js';

/**
 * Declares the plugin's settings and nothing else yet.
 *
 * The `jira` namespace and the `net:*.atlassian.net` permission are in `tyto-plugin.json` for
 * the verbs that come next (`jira.pull`, then `jira.refresh`); until they exist this plugin
 * makes no request and reads no secret.
 */
export function activate(host: PluginHost): Disposable {
  const registered = SETTINGS.map((setting) => host.registerConfiguration(setting));
  return {
    dispose() {
      for (const registration of registered) registration.dispose();
    },
  };
}
