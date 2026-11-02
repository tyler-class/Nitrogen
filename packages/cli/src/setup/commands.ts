import * as p from '@clack/prompts';
import { existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { execFile } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { realShell } from './shell.ts';
import { Setup, type UI } from './setup.ts';
import { loadState, saveState, statePath } from './state.ts';
import { formatChecks, runDoctor } from './doctor.ts';

export function openUrl(url: string): void {
  const cmd = process.platform === 'darwin' ? 'open' : process.platform === 'win32' ? 'start' : 'xdg-open';
  execFile(cmd, [url], () => {});
  console.log(`Open: ${url}`);
}

export const clackUI: UI = {
  info: (m) => p.log.info(m),
  step: (m) => p.log.step(m),
  needsYou: (lines) => p.note(lines.join('\n'), 'Needs you'),
  async confirm(m) {
    const r = await p.confirm({ message: m });
    if (p.isCancel(r)) process.exit(1);
    return r;
  },
  async text(m, initial) {
    const r = await p.text({ message: m, ...(initial ? { initialValue: initial } : {}) });
    if (p.isCancel(r)) process.exit(1);
    return r;
  },
};

/** Locate the Nitrogen app checkout (the monorepo) that holds the Worker and web app. */
export function findAppDir(explicit?: string): string {
  const candidates = [explicit, process.env.NITROGEN_APP_DIR, process.cwd(), resolve(import.meta.dirname, '../../../..')].filter(Boolean) as string[];
  for (const c of candidates) if (existsSync(join(c, 'apps/worker/wrangler.jsonc'))) return c;
  throw new Error('Run setup from a clone of the Nitrogen repo (or pass --app-dir). `npm create nitrogen@latest` clones it for you.');
}

export async function setupCommand(o: { appDir?: string; repo?: string; workerName?: string; allowGithubId?: number; yes?: boolean; branch?: string; demo?: boolean }): Promise<number> {
  p.intro('Nitrogen setup');
  const s = new Setup({ shell: realShell, ui: clackUI, fetchImpl: fetch, open: openUrl, appDir: findAppDir(o.appDir) }, o);
  try {
    await s.run();
    p.outro('Done.');
    return 0;
  } catch (e) {
    p.log.error(s.masker.mask((e as Error).message));
    p.outro('Setup stopped. Fix the problem and run `nitrogen setup` again; finished steps are skipped.');
    return 1;
  }
}

export async function doctorCommand(o: { url?: string }): Promise<number> {
  const url = o.url ?? loadState().workerUrl;
  if (!url) {
    console.error('No Worker URL. Pass --url or run `nitrogen setup`.');
    return 1;
  }
  const checks = await runDoctor({ url });
  console.log(formatChecks(checks));
  return checks.every((c) => c.ok) ? 0 : 1;
}

export async function teardownCommand(o: { appDir?: string; deleteRepo?: boolean; yes?: boolean }): Promise<number> {
  const st = loadState();
  const appDir = findAppDir(o.appDir);
  const cwd = join(appDir, 'apps/worker');
  if (!o.yes && !(await clackUI.confirm(`Delete Worker ${st.workerName}, D1 ${st.d1Name} and its KV namespace?`))) return 1;
  const w = (args: string[], input?: string) => realShell.run('npx', ['--yes', 'wrangler', ...args], { cwd, ...(input ? { input } : {}) });
  if (st.workerName) await w(['delete', '--name', st.workerName, '--force']);
  if (st.d1Name) await w(['d1', 'delete', st.d1Name, '--skip-confirmation'], 'y\n');
  if (st.kvId) await w(['kv', 'namespace', 'delete', '--namespace-id', st.kvId], 'y\n');
  if (st.appSlug) console.log(`Delete the GitHub App by hand (GitHub has no API for it): https://github.com/settings/apps/${st.appSlug}/advanced`);
  if (o.deleteRepo && st.repo) {
    const typed = await clackUI.text(`Type ${st.repo} to delete the notes repo`);
    if (typed === st.repo) await realShell.run('gh', ['repo', 'delete', st.repo, '--yes']);
    else console.log('Names did not match; the notes repo was kept.');
  }
  saveState({ version: 1, completed: [] });
  console.log(`Teardown finished. State reset at ${statePath()}.`);
  return 0;
}

export async function rotateKeysCommand(o: { appDir?: string }): Promise<number> {
  const st = loadState();
  if (!st.repo || !st.workerName) {
    console.error('Run setup first.');
    return 1;
  }
  const cwd = join(findAppDir(o.appDir), 'apps/worker');
  for (const name of ['SESSION_SECRET', 'COOKIE_ENCRYPTION_KEY', 'INGEST_HMAC_SECRET']) {
    const v = randomBytes(32).toString('base64url');
    const r = await realShell.run('npx', ['--yes', 'wrangler', 'secret', 'put', name, '-c', 'wrangler.generated.jsonc'], { cwd, input: v });
    if (r.code !== 0) return 1;
    if (name === 'INGEST_HMAC_SECRET') await realShell.run('gh', ['secret', 'set', 'NITROGEN_INGEST_SECRET', '-R', st.repo], { input: v });
  }
  console.log('Rotated session, cookie and ingest secrets. Everyone is signed out. To rotate the GitHub App key, generate a new key in the App settings and run: wrangler secret put GITHUB_APP_PRIVATE_KEY < key.pem');
  return 0;
}

export async function upgradeCommand(o: { appDir?: string }): Promise<number> {
  const appDir = findAppDir(o.appDir);
  const cwd = join(appDir, 'apps/worker');
  const steps: [string, string[]][] = [
    ['npx', ['--yes', 'wrangler', 'd1', 'migrations', 'apply', 'DB', '--remote', '-c', 'wrangler.generated.jsonc']],
    ['pnpm', ['--filter', '@nitrogen/web', 'build']],
    ['npx', ['--yes', 'wrangler', 'deploy', '-c', 'wrangler.generated.jsonc']],
  ];
  for (const [cmd, args] of steps) {
    const r = await realShell.run(cmd, args, { cwd: cmd === 'pnpm' ? appDir : cwd, input: 'y\n' });
    if (r.code !== 0) {
      console.error(r.stderr);
      return 1;
    }
  }
  const st = loadState();
  st.completed = st.completed.filter((c) => c !== 'init');
  saveState(st);
  console.log('Upgraded. Run `nitrogen setup` to refresh FORMAT.md in the notes repo (existing files are kept; delete FORMAT.md there first to regenerate it).');
  return 0;
}
