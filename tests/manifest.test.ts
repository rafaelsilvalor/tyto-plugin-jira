import { readFileSync } from 'node:fs';

import { describe, expect, it } from 'vitest';

import { activate } from '../src/index.js';
import type { FormConfigurationContribution, PluginHost } from '../src/tyto-api.js';
import { LOCAL_KEY, pluginManifestSchema, settingFormSchema } from './tyto-schemas.js';

const manifest: unknown = JSON.parse(
  readFileSync(new URL('../tyto-plugin.json', import.meta.url), 'utf8'),
);

/** A host that records what the plugin registers, and how many registrations it withdrew. */
function recordingHost() {
  const settings: FormConfigurationContribution[] = [];
  let disposed = 0;
  const host: PluginHost = {
    registerConfiguration(setting) {
      settings.push(setting);
      return {
        dispose() {
          disposed += 1;
        },
      };
    },
  };
  return { host, settings, disposed: () => disposed };
}

describe('tyto-plugin.json', () => {
  it('is a manifest Tyto accepts', () => {
    const parsed = pluginManifestSchema.safeParse(manifest);
    expect(parsed.error?.issues ?? []).toEqual([]);
  });

  it('reaches only Atlassian Cloud, and holds only the token and the email as secrets', () => {
    const parsed = pluginManifestSchema.parse(manifest);
    expect(parsed.name).toBe('jira');
    expect(parsed.namespace).toBe('jira');
    expect(parsed.permissions).toEqual([
      'net:*.atlassian.net',
      'credentials:api-token',
      'credentials:email',
    ]);
  });

  it('carries the version package.json carries', () => {
    const packageJson = JSON.parse(
      readFileSync(new URL('../package.json', import.meta.url), 'utf8'),
    ) as { version: string };
    expect(pluginManifestSchema.parse(manifest).version).toBe(packageJson.version);
  });
});

describe('activate', () => {
  it('registers only into the points the manifest declares', () => {
    const { host, settings } = recordingHost();
    activate(host);
    const declared = pluginManifestSchema.parse(manifest).contributes;
    expect(settings.length).toBeGreaterThan(0);
    expect(declared).toContain('configuration');
  });

  it('declares settings whose key and form Tyto accepts, and whose default the form allows', () => {
    const { host, settings } = recordingHost();
    activate(host);
    expect(settings.map((setting) => setting.id)).toEqual(['baseUrl', 'email']);
    for (const setting of settings) {
      expect(setting.id).toMatch(LOCAL_KEY);
      expect(settingFormSchema.safeParse(setting.form).error?.issues ?? []).toEqual([]);
      expect(setting.default).toBeNull();
      expect('nullable' in setting.form && setting.form.nullable).toBe(true);
    }
  });

  it('withdraws every setting when disposed', () => {
    const recorded = recordingHost();
    activate(recorded.host).dispose();
    expect(recorded.disposed()).toBe(recorded.settings.length);
  });
});
