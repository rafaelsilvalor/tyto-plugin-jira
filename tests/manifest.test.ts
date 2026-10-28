import { readFileSync } from 'node:fs';

import { PLUGIN_API_VERSION, createPluginHost, type Disposable } from '@tyto/plugin-api';
import { testPlugin } from '@tyto/plugin-api/testing';
import { describe, expect, it } from 'vitest';

import { activate } from '../src/index.js';

/**
 * The plugin as Tyto loads it: the manifest's text checked by install against the
 * `@tyto/plugin-api` this repository installed, and the committed `dist/index.js` — the file
 * Tyto copies and never builds — activated over the isolation protocol (Tyto ADR 0150).
 */
const manifest = readFileSync(new URL('../tyto-plugin.json', import.meta.url), 'utf8');
const entry = new URL('../dist/index.js', import.meta.url).href;
const load = (): Promise<unknown> => import(entry);

async function harness(settings?: Readonly<Record<string, unknown>>) {
  const loaded = await testPlugin({ manifest, load, ...(settings ? { settings } : {}) });
  if (!loaded.ok) {
    throw new Error(loaded.error.map((item) => `${item.code}: ${item.message}`).join('\n'));
  }
  return loaded.value;
}

describe('tyto-plugin.json', () => {
  it(`is a plugin the installed plugin API (${PLUGIN_API_VERSION}) installs and activates`, async () => {
    const loaded = await testPlugin({ manifest, load });
    expect(loaded.ok ? [] : loaded.error.map((item) => `${item.code}: ${item.message}`)).toEqual(
      [],
    );
    if (loaded.ok) await loaded.value.close();
  });

  it('reaches only Atlassian Cloud, and holds only the token and the email as secrets', async () => {
    const plugin = await harness();
    expect(plugin.manifest.name).toBe('jira');
    expect(plugin.manifest.namespace).toBe('jira');
    expect(plugin.manifest.permissions).toEqual([
      'net:*.atlassian.net',
      'credentials:api-token',
      'credentials:email',
    ]);
    await plugin.close();
  });

  it('carries the version package.json carries', async () => {
    const packageJson = JSON.parse(
      readFileSync(new URL('../package.json', import.meta.url), 'utf8'),
    ) as { version: string };
    const plugin = await harness();
    expect(plugin.manifest.version).toBe(packageJson.version);
    await plugin.close();
  });
});

describe('activate', () => {
  it('declares two settings with no default, and no verb yet', async () => {
    const plugin = await harness();
    const declared = plugin.host.registry.configurations();
    expect(declared.map((setting) => setting.key)).toEqual(['jira.baseUrl', 'jira.email']);
    expect(plugin.settings.values).toEqual({ 'jira.baseUrl': null, 'jira.email': null });
    expect(plugin.settings.diagnostics).toEqual([]);
    expect(plugin.host.registry.recipeVerbs()).toEqual([]);
    await plugin.close();
  });

  it('takes a site written in settings.json, and refuses one that is not a URL', async () => {
    const written = await harness({ 'jira.baseUrl': 'https://example.atlassian.net' });
    expect(written.settings.values['jira.baseUrl']).toBe('https://example.atlassian.net');
    await written.close();

    const refused = await harness({ 'jira.baseUrl': 'example' });
    expect(refused.settings.diagnostics.map((item) => item.code)).toEqual(['W_SETTING_INVALID']);
    expect(refused.settings.values['jira.baseUrl']).toBeNull();
    await refused.close();
  });

  it('withdraws every setting when disposed', () => {
    const host = createPluginHost();
    let registered: Disposable | undefined;
    const activated = host.tryActivate({
      id: 'jira',
      manifest: JSON.parse(manifest) as unknown,
      activate(pluginHost) {
        registered = activate(pluginHost);
        return registered;
      },
    });
    expect(activated.ok).toBe(true);
    expect(host.registry.configurations()).toHaveLength(2);
    registered?.dispose();
    expect(host.registry.configurations()).toEqual([]);
  });
});
