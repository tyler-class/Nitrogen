import { build } from 'esbuild';
import { chmodSync } from 'node:fs';

await build({
  entryPoints: ['src/bin.ts', 'src/index.ts'],
  outdir: 'dist',
  bundle: true,
  platform: 'node',
  target: 'node22',
  format: 'esm',
  banner: { js: "import { createRequire as __cr } from 'node:module'; const require = __cr(import.meta.url);" },
  external: ['@clack/prompts', 'qrcode-terminal'],
  logLevel: 'warning',
});
chmodSync('dist/bin.js', 0o755);
