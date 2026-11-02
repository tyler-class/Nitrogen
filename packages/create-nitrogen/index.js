#!/usr/bin/env node
// npm create nitrogen@latest [dir] [-- setup flags]
import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';

const REPO = process.env.NITROGEN_GIT ?? 'https://github.com/tyler-class/nitrogen.git';
const args = process.argv.slice(2);
const dir = resolve(args[0] && !args[0].startsWith('-') ? args.shift() : 'nitrogen');

function run(cmd, cmdArgs, cwd) {
  const r = spawnSync(cmd, cmdArgs, { stdio: 'inherit', cwd, shell: process.platform === 'win32' });
  if (r.status !== 0) {
    console.error(`\n${cmd} ${cmdArgs.join(' ')} failed. Fix the problem and run the command again.`);
    process.exit(r.status ?? 1);
  }
}

if (Number(process.versions.node.split('.')[0]) < 22) {
  console.error('Nitrogen needs Node 22 or newer.');
  process.exit(1);
}
if (!existsSync(resolve(dir, 'apps/worker/wrangler.jsonc'))) run('git', ['clone', '--depth', '1', REPO, dir]);
run('corepack', ['enable'], dir);
run('pnpm', ['install', '--frozen-lockfile'], dir);
run('pnpm', ['--filter', '@nitrogen/web', 'build'], dir);
run('pnpm', ['n2', 'setup', '--app-dir', dir, ...args], dir);
