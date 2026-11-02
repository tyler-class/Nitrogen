// Bundles the CLI into a single file the composite action runs with `node`.
import { build } from 'esbuild';
await build({
  entryPoints: ['../packages/cli/src/bin.ts'],
  outfile: 'dist/nitrogen.mjs',
  bundle: true,
  platform: 'node',
  target: 'node22',
  format: 'esm',
  banner: { js: "import { createRequire as __cr } from 'node:module'; const require = __cr(import.meta.url);" },
  external: ['@clack/prompts', 'qrcode-terminal'],
  logLevel: 'warning',
});
