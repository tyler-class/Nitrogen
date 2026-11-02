import { describe, expect, it } from 'vitest';
import { generateKeyPairSync } from 'node:crypto';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { FakeGitHub } from '@nitrogen/testing';
import { Setup, type UI } from '../src/setup/setup.ts';
import type { Shell, RunOptions } from '../src/setup/shell.ts';
import { saveState } from '../src/setup/state.ts';
import { buildManifest } from '../src/setup/github-app.ts';
import { initFiles } from '../src/setup/notes-init.ts';
import { lintPage, buildVaultContext } from '@nitrogen/core';

const { privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
const PEM = privateKey.export({ type: 'pkcs1', format: 'pem' }).toString();

interface Call {
  cmd: string;
  args: string[];
  input?: string;
}

function fakeWorld() {
  const calls: Call[] = [];
  const secrets = new Set<string>();
  const repos = new Set<string>();
  let d1: { name: string; uuid: string }[] = [];
  let kv: { id: string; title: string }[] = [];
  const pushed: string[] = [];
  const shell: Shell = {
    async run(cmd: string, args: string[], opts: RunOptions = {}) {
      calls.push({ cmd, args, ...(opts.input !== undefined ? { input: opts.input } : {}) });
      const a = cmd === 'npx' ? args.slice(2) : args;
      const j = (o: unknown) => ({ code: 0, stdout: JSON.stringify(o), stderr: '' });
      const ok = (stdout = '') => ({ code: 0, stdout, stderr: '' });
      if (cmd === 'gh') {
        if (a[0] === 'api' && a[1] === 'user') return j({ id: 1001, login: 'octo' });
        if (a[0] === 'repo' && a[1] === 'view') return repos.has(a[2]!) ? j({ name: 'notes', isPrivate: true }) : { code: 1, stdout: '', stderr: 'not found' };
        if (a[0] === 'repo' && a[1] === 'create') {
          repos.add(a[2]!);
          return ok();
        }
        if (a[0] === 'repo' && a[1] === 'clone') {
          mkdirSync(a[3]!, { recursive: true });
          return ok();
        }
        if (a[0] === 'secret' && a[1] === 'list') return j([...secrets].filter((s) => s.startsWith('GH:')).map((s) => ({ name: s.slice(3) })));
        if (a[0] === 'secret' && a[1] === 'set') {
          secrets.add(`GH:${a[2]}`);
          return ok();
        }
        return ok();
      }
      if (cmd === 'git') {
        if (a.includes('push')) pushed.push('push');
        return ok();
      }
      if (cmd === 'npx') {
        const k = a.join(' ');
        if (k === 'whoami') return ok('You are logged in');
        if (k === 'd1 list --json') return j(d1);
        if (a[0] === 'd1' && a[1] === 'create') {
          d1 = [...d1, { name: a[2]!, uuid: '11111111-2222-3333-4444-555555555555' }];
          return ok('"database_id": "11111111-2222-3333-4444-555555555555"');
        }
        if (k === 'kv namespace list') return j(kv);
        if (a[0] === 'kv' && a[2] === 'create') {
          kv = [...kv, { id: 'a'.repeat(32), title: a[3]! }];
          return ok(`id = "${'a'.repeat(32)}"`);
        }
        if (a[0] === 'deploy') return ok('Deployed nitrogen-notes\n  https://nitrogen-notes.octo.workers.dev');
        if (a[0] === 'secret' && a[1] === 'list') return j([...secrets].filter((s) => !s.startsWith('GH:')).map((name) => ({ name })));
        if (a[0] === 'secret' && a[1] === 'put') {
          secrets.add(a[2]!);
          return ok();
        }
        return ok();
      }
      return ok();
    },
  };
  return { shell, calls, secrets, pushed };
}

function makeAppDir(): string {
  const d = mkdtempSync(join(tmpdir(), 'n2-app-'));
  mkdirSync(join(d, 'apps/worker'), { recursive: true });
  mkdirSync(join(d, 'apps/web/dist'), { recursive: true });
  writeFileSync(join(d, 'apps/worker/wrangler.jsonc'), '{}');
  writeFileSync(join(d, 'apps/web/dist/index.html'), '<!doctype html>');
  return d;
}

const ui = (): UI & { log: string[] } => {
  const log: string[] = [];
  return { log, info: (m) => log.push(m), step: (m) => log.push(`# ${m}`), needsYou: (l) => log.push(`! ${l.join(' ')}`), confirm: async () => true, text: async (_m, i) => i ?? 'notes' };
};

describe('setup', () => {
  it('reaches a deployment with three browser steps, and a second run changes nothing', async () => {
    const world = fakeWorld();
    const gh = new FakeGitHub({ owner: 'octo', repo: 'notes' });
    const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = new URL(typeof input === 'string' || input instanceof URL ? input : input.url);
      if (url.hostname.endsWith('workers.dev')) {
        if (url.pathname === '/api/health') return Response.json({ version: '0.1.0', d1: { migrated: true, pages: 3 }, kv: true, secrets: Object.fromEntries([...world.secrets].map((s) => [s, true])), repo: { owner: 'octo', repo: 'notes' }, allowlist: 1 });
        return new Response('nope', { status: 401, headers: { 'www-authenticate': 'Bearer resource_metadata="x"' } });
      }
      return gh.fetch(input, init);
    }) as typeof fetch;
    const appDir = makeAppDir();
    const statePath = join(appDir, 'state.json');
    saveState({ version: 1, completed: [] }, statePath);
    const opened: string[] = [];
    let flows = 0;
    const deps = {
      shell: world.shell,
      fetchImpl,
      open: (u: string) => opened.push(u),
      appDir,
      statePath,
      sleep: async () => {},
      isRoot: () => false,
      manifestFlow: async () => {
        flows++;
        return { id: 99, slug: 'nitrogen-octo-ab12', client_id: 'Iv1.abc', client_secret: 'cs_supersecret', webhook_secret: 'wh_supersecret', pem: PEM };
      },
    };
    const u1 = ui();
    await new Setup({ ...deps, ui: u1 }, { yes: true, repo: 'notes' }).run();
    expect(flows).toBe(1);
    expect(u1.log.filter((l) => l.startsWith('!')).length).toBe(2); // app create + install (Cloudflare already logged in)
    for (const name of ['GITHUB_APP_ID', 'GITHUB_APP_PRIVATE_KEY', 'GITHUB_INSTALLATION_ID', 'GITHUB_OAUTH_CLIENT_ID', 'GITHUB_OAUTH_CLIENT_SECRET', 'GITHUB_WEBHOOK_SECRET', 'SESSION_SECRET', 'INGEST_HMAC_SECRET', 'COOKIE_ENCRYPTION_KEY', 'GH:NITROGEN_INGEST_SECRET'])
      expect(world.secrets.has(name), name).toBe(true);
    // Secrets only travel over stdin, never argv.
    for (const c of world.calls) for (const a of c.args) expect(a).not.toMatch(/supersecret|BEGIN RSA/);
    const state = readFileSync(statePath, 'utf8');
    expect(state).not.toMatch(/supersecret|BEGIN RSA|pem/);
    expect(JSON.parse(state)).toMatchObject({ repo: 'octo/notes', installationId: 42, workerUrl: 'https://nitrogen-notes.octo.workers.dev' });
    const cfg = readFileSync(join(appDir, 'apps/worker/wrangler.generated.jsonc'), 'utf8');
    expect(JSON.parse(cfg).vars).toMatchObject({ GITHUB_OWNER: 'octo', GITHUB_REPO: 'notes', ALLOWED_GITHUB_IDS: '1001' });
    expect(world.pushed.length).toBe(1);
    expect(u1.log.join('\n')).toContain('✔ Worker reachable');

    // Second run: nothing mutating.
    const before = world.calls.length;
    const u2 = ui();
    await new Setup({ ...deps, ui: u2 }, { yes: true }).run();
    const mutating = world.calls.slice(before).filter((c) => /create|put|deploy|push|set|apply|login/.test(c.args.join(' ')));
    expect(mutating.map((c) => c.args.join(' '))).toEqual([]);
    expect(flows).toBe(1);
  });

  it('masks secrets in errors', async () => {
    const { Masker } = await import('../src/setup/shell.ts');
    const m = new Masker();
    m.add('cs_supersecret');
    expect(m.mask('oops cs_supersecret here')).toBe('oops ******** here');
  });

  it('manifest has least-privilege permissions and the webhook', () => {
    const m = buildManifest({ name: 'n', workerUrl: 'https://w.dev', redirectUrl: 'http://localhost:1/callback' });
    expect(m.default_permissions).toEqual({ contents: 'write', metadata: 'read' });
    expect(m.hook_attributes).toEqual({ url: 'https://w.dev/hooks/github', active: true });
    expect(m.public).toBe(false);
  });

  it('init files lint clean', () => {
    const files = initFiles();
    const ctx = buildVaultContext(Object.entries(files).map(([path, content]) => ({ path, content })));
    for (const [path, content] of Object.entries(files)) if (ctx.pages.some((p) => p.path === path)) expect(lintPage(content, ctx, { path }), path).toEqual([]);
    expect(existsSync).toBeDefined();
  });
});
