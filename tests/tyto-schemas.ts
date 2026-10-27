import { z } from 'zod';

/**
 * Tyto's own checks on a plugin's manifest and settings, vendored for the tests only, because
 * `@tyto/plugin-api` is not published to npm. The plugin's bundle never imports this file.
 *
 * Copied from rafaelsilvalor/tyto at 5cab61173dfcfbb384d490660f2cfa2933fafc9e
 * (`@tyto/plugin-api` 0.4.1), from:
 *
 *   packages/plugin-api/src/manifest.ts        pluginManifestSchema, CONTRIBUTION_POINTS
 *   packages/plugin-api/src/setting-form.ts    settingFormSchema (the shape, not the converter)
 *   packages/plugin-api/src/configuration.ts   LOCAL_KEY
 *
 * When Tyto changes one of these, copy it again and move the SHA above.
 */

export const CONTRIBUTION_POINTS = [
  'source',
  'sink',
  'exporter',
  'rasterizer',
  'template-pack',
  'brand-kit',
  'directive',
  'editor.command',
  'editor.keymap',
  'editor.vim',
  'panel',
  'configuration',
  'theme',
  'asset-source',
  'font-source',
  'recipe-verb',
  'recipe-derivation',
] as const;

const NAMESPACED_POINTS: readonly string[] = ['recipe-verb', 'recipe-derivation'];

const NAME = /^[a-z0-9][a-z0-9-]*$/;
const ENGINE_RANGE =
  /^(>=|<=|>|<|\^|~|=)?\d+(\.\d+){0,2}(\s*\|\|\s*(>=|<=|>|<|\^|~|=)?\d+(\.\d+){0,2})*$/;
const VERSION = /^\d+\.\d+\.\d+(-[0-9A-Za-z-.]+)?$/;
const WORD = /^[a-z][a-z0-9-]*$/;

export const pluginManifestSchema = z
  .strictObject({
    name: z.string().regex(NAME),
    version: z.string().regex(VERSION),
    engine: z.string().regex(ENGINE_RANGE),
    contributes: z
      .array(z.enum(CONTRIBUTION_POINTS))
      .nonempty()
      .refine((points) => new Set(points).size === points.length, 'must not repeat a point'),
    permissions: z
      .array(z.string().min(1))
      .refine((values) => new Set(values).size === values.length, 'must not repeat a permission'),
    config: z.strictObject({ $schema: z.string().min(1) }).optional(),
    namespace: z.string().regex(WORD).optional(),
    writes: z
      .array(z.string().regex(WORD))
      .refine((values) => new Set(values).size === values.length, 'must not repeat a write')
      .optional(),
  })
  .superRefine((manifest, context) => {
    const namespaced = manifest.contributes.filter((point) => NAMESPACED_POINTS.includes(point));
    if (namespaced.length > 0 && manifest.namespace === undefined) {
      context.addIssue({ code: 'custom', path: ['namespace'], message: 'is required' });
    }
    if (manifest.writes !== undefined && !manifest.contributes.includes('recipe-verb')) {
      context.addIssue({ code: 'custom', path: ['writes'], message: 'needs a recipe-verb' });
    }
  });

const formValueSchema = z.union([z.string().max(1000), z.number(), z.boolean(), z.null()]);
const lengthSchema = z.number().int().nonnegative();

const scalarFormSchema = z.strictObject({
  type: z.enum(['string', 'number', 'integer', 'boolean']),
  nullable: z.boolean().optional(),
  enum: z.array(formValueSchema).min(1).max(200).optional(),
  minimum: z.number().optional(),
  maximum: z.number().optional(),
  minLength: lengthSchema.optional(),
  maxLength: lengthSchema.optional(),
  pattern: z.string().min(1).max(512).optional(),
  format: z.literal('uri').optional(),
});

export const settingFormSchema = z.discriminatedUnion('type', [
  scalarFormSchema,
  z.strictObject({
    type: z.literal('array'),
    items: scalarFormSchema,
    uniqueItems: z.boolean().optional(),
  }),
]);

/** A setting key as the plugin names it; the host adds `jira.` itself. */
export const LOCAL_KEY = /^[A-Za-z][A-Za-z0-9]*$/;
