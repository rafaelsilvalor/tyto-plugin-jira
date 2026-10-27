/**
 * The part of Tyto's plugin API this plugin uses, vendored because `@tyto/plugin-api` is not
 * published to npm.
 *
 * Copied from rafaelsilvalor/tyto at 5cab61173dfcfbb384d490660f2cfa2933fafc9e
 * (`@tyto/plugin-api` 0.4.1, RPC protocol 8), from:
 *
 *   packages/plugin-api/src/setting-form.ts    SettingScalarType, SettingFormValue, SettingScalarForm,
 *                                              SettingListForm, SettingForm
 *   packages/plugin-api/src/configuration.ts   FormConfigurationContribution, SettingOption
 *   packages/plugin-api/src/host.ts            PluginHost (only the members used here), Disposable
 *
 * One narrowing, on purpose: `registerConfiguration` takes a Zod schema or a form, and an
 * installed plugin runs in its own process where only a form crosses (Tyto ADR 0145), so this
 * file declares the form alone and does not depend on Zod.
 *
 * When Tyto changes one of these, copy the new shape here and move the SHA above.
 */

export type SettingScalarType = 'string' | 'number' | 'integer' | 'boolean';

export type SettingFormValue = string | number | boolean | null;

export interface SettingScalarForm {
  readonly type: SettingScalarType;
  readonly nullable?: boolean;
  readonly enum?: readonly SettingFormValue[];
  readonly minimum?: number;
  readonly maximum?: number;
  readonly minLength?: number;
  readonly maxLength?: number;
  readonly pattern?: string;
  readonly format?: 'uri';
}

export interface SettingListForm {
  readonly type: 'array';
  readonly items: SettingScalarForm;
  readonly uniqueItems?: boolean;
}

export type SettingForm = SettingScalarForm | SettingListForm;

/** One value a setting may take, and what it does. */
export interface SettingOption {
  readonly value: string | number | boolean | null;
  readonly description: string;
}

/** A setting declared as data, which is what crosses to an installed plugin's process. */
export interface FormConfigurationContribution {
  /** Letters and digits, starting with a letter; the host prefixes the plugin id. */
  readonly id: string;
  readonly form: SettingForm;
  /** What applies when the file says nothing, or says something the form refuses. */
  readonly default: unknown;
  /** One sentence for the person reading the settings. */
  readonly description: string;
  readonly options?: readonly SettingOption[];
}

export interface Disposable {
  dispose(): void;
}

export interface PluginHost {
  registerConfiguration(setting: FormConfigurationContribution): Disposable;
}
