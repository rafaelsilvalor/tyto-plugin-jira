import { defineConfig } from 'tsup';

/**
 * One ES module with no imports, because Tyto installs a plugin by copying its folder and
 * never builds it: `dist/index.js` is committed, and CI fails when it differs from a fresh
 * build of `src/`.
 */
export default defineConfig({
  entry: { index: 'src/index.ts' },
  format: ['esm'],
  target: 'es2022',
  platform: 'neutral',
  bundle: true,
  splitting: false,
  sourcemap: false,
  dts: false,
  minify: false,
  clean: true,
});
