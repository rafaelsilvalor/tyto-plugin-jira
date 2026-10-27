import { builtinModules } from 'node:module';

import js from '@eslint/js';
import prettier from 'eslint-config-prettier';
import globals from 'globals';
import tseslint from 'typescript-eslint';

/**
 * Mirrors Tyto's own configuration. The plugin's code runs in whatever process Tyto gives a
 * plugin, so it is held to Tyto's pure-package rule: no Node built-ins and no Node or DOM
 * globals. Tests and scripts run in Node and may use both.
 */
const nodeBuiltinPatterns = [
  'node:*',
  ...builtinModules.filter((name) => !name.startsWith('_')),
  ...builtinModules.filter((name) => !name.startsWith('_')).map((name) => `${name}/*`),
];

const NO_RUNTIME_IN_PLUGIN =
  'The plugin runs wherever Tyto runs a plugin: it reaches the outside only through the host ' +
  'it is handed, never through a Node built-in or a global.';

const RUNTIME_GLOBALS = [
  'window',
  'document',
  'navigator',
  'fetch',
  'process',
  'require',
  'global',
  '__dirname',
  '__filename',
  'Buffer',
];

export default tseslint.config(
  { ignores: ['**/dist/**', '**/node_modules/**', '**/coverage/**'] },

  js.configs.recommended,
  ...tseslint.configs.recommended,

  {
    rules: {
      '@typescript-eslint/consistent-type-imports': [
        'error',
        { prefer: 'type-imports', fixStyle: 'inline-type-imports' },
      ],
      '@typescript-eslint/no-unused-vars': [
        'error',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_' },
      ],
      'no-console': ['error', { allow: ['warn', 'error'] }],
      eqeqeq: ['error', 'always', { null: 'ignore' }],
    },
  },

  {
    name: 'boundary/plugin',
    files: ['src/**/*.ts'],
    ignores: ['src/**/*.test.ts'],
    languageOptions: { globals: {} },
    rules: {
      '@typescript-eslint/no-restricted-imports': [
        'error',
        {
          patterns: [
            { group: nodeBuiltinPatterns, message: NO_RUNTIME_IN_PLUGIN, allowTypeImports: false },
          ],
        },
      ],
      'no-restricted-globals': [
        'error',
        ...RUNTIME_GLOBALS.map((name) => ({ name, message: NO_RUNTIME_IN_PLUGIN })),
      ],
    },
  },

  {
    name: 'node/tests-and-scripts',
    files: ['src/**/*.test.ts', 'tests/**/*.ts', 'scripts/**/*.{js,mjs}', '*.config.{js,ts}'],
    languageOptions: { globals: globals.node },
  },

  prettier,
);
