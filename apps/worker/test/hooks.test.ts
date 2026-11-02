import { describe, expect, it } from 'vitest';
import { setup, DEMO } from './helpers.ts';
import { app } from '../src/app.ts';
import { hmacHex, gitBlobSha } from '../src/util/crypto.ts';
import { indexRowsFromScan, scanPage } from '@nitrogen/core/light';

type J = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any

describe('webhook', () => {
  it('verifies signatures, logs external commits and reindexes pushed paths', async () => {
    const { env, fake, call } = await setup();
    await call('GET', '/api/tree');
    const before = fake.head();
    const after = fake.push({ 'architecture/sync-design.md': '# Sync design\n\nNow links [ADR](/decisions/adr-1.md "rel:cites").\n', 'index.md': null }, 'Edit from laptop');
    const payload = JSON.stringify({ ref: 'refs/heads/main', before, after, commits: [{ id: after, message: 'Edit from laptop', modified: ['architecture/sync-design.md'], removed: ['index.md'], added: [] }] });
    const bad = await app.fetch(new Request('https://n2.example/hooks/github', { method: 'POST', headers: { 'x-github-event': 'push', 'x-hub-signature-256': 'sha256=00' }, body: payload }), env);
    expect(bad.status).toBe(401);
    const sig = `sha256=${await hmacHex('test-webhook-secret', payload)}`;
    const ok = await app.fetch(new Request('https://n2.example/hooks/github', { method: 'POST', headers: { 'x-github-event': 'push', 'x-hub-signature-256': sig }, body: payload }), env);
    expect(ok.status).toBe(200);
    const tree = (await call('GET', '/api/tree')).json as J;
    expect(tree.head).toBe(after);
    expect(tree.pages.map((p: J) => p.path)).not.toContain('index.md');
    const out = (await call('GET', '/api/links?page=architecture/sync-design.md&dir=out')).json as J;
    expect(out.outgoing[0].links[0].rel).toBe('cites');
    const act = (await call('GET', '/api/activity')).json as J;
    expect(act.activity[0]).toMatchObject({ actor: 'external', message: 'Edit from laptop' });
  });
});

describe('admin ingest', () => {
  async function post(env: J, body: unknown, secret = 'test-ingest-secret', ts = String(Math.floor(Date.now() / 1000))) {
    const raw = JSON.stringify(body);
    return app.fetch(
      new Request('https://n2.example/admin/ingest', { method: 'POST', headers: { 'x-nitrogen-timestamp': ts, 'x-nitrogen-signature': `sha256=${await hmacHex(secret, `${ts}.${raw}`)}` }, body: raw }),
      env as never,
    );
  }
  it('accepts signed batches, prunes on the last one, rejects bad signatures and stale timestamps', async () => {
    const { env, call } = await setup();
    const rows = await Promise.all(
      Object.entries(DEMO)
        .filter(([p]) => p.endsWith('.md'))
        .map(async ([p, src]) => {
          const { meta: _m, ...r } = indexRowsFromScan(p, src, await gitBlobSha(src), scanPage(src), null);
          return r;
        }),
    );
    const allPaths = rows.map((r) => r.page.path);
    expect((await post(env, { head: 'a'.repeat(40), mode: 'full', batch: 1, of: 1, allPaths, pages: rows }, 'wrong')).status).toBe(401);
    expect((await post(env, { head: null, mode: 'full', batch: 1, of: 1, allPaths, pages: rows }, undefined, '1000')).status).toBe(401);
    const r1 = await post(env, { head: 'a'.repeat(40), mode: 'full', batch: 1, of: 2, allPaths, pages: rows.slice(0, 2), config: 'version: 1\n', assets: [{ path: 'images/a.png', sha: 'x', size: 7 }] });
    expect(r1.status).toBe(200);
    const r2 = await post(env, { head: 'a'.repeat(40), mode: 'full', batch: 2, of: 2, allPaths: allPaths.slice(1), pages: rows.slice(2) });
    expect(r2.status).toBe(200);
    const tree = (await call('GET', '/api/tree')).json as J;
    expect(tree.head).toBe('a'.repeat(40));
    expect(tree.pages.map((p: J) => p.path).sort()).toEqual([...allPaths.slice(1)].sort());
  });
});

describe('github login', () => {
  it('runs the web flow and enforces the allowlist', async () => {
    const { env, fake } = await setup({ users: [{ id: 1001, login: 'octo' }, { id: 7, login: 'mallory' }] });
    const e = { ...env, GITHUB_WEB: 'https://github.com' };
    const start = await app.fetch(new Request('https://n2.example/auth/login?return=/p/x'), e);
    expect(start.status).toBe(302);
    const loc = new URL(start.headers.get('location')!);
    expect(loc.origin + loc.pathname).toBe('https://github.com/login/oauth/authorize');
    const state = loc.searchParams.get('state')!;
    const stateCookie = start.headers.get('set-cookie')!.split(';')[0]!;
    fake.grantUser(1001, 'code-ok');
    const cb = await app.fetch(new Request(`https://n2.example/auth/callback?code=code-ok&state=${state}`, { headers: { cookie: stateCookie } }), e);
    expect(cb.status).toBe(302);
    expect(cb.headers.get('location')).toBe('/p/x');
    const cookies = cb.headers.getSetCookie().join('\n');
    expect(cookies).toMatch(/n2_session=.*HttpOnly/);
    expect(cookies).toMatch(/n2_csrf=/);
    // wrong state
    fake.grantUser(1001, 'code-2');
    expect((await app.fetch(new Request(`https://n2.example/auth/callback?code=code-2&state=nope`, { headers: { cookie: stateCookie } }), e)).status).toBe(400);
    // not allowlisted
    const s2 = await app.fetch(new Request('https://n2.example/auth/login'), e);
    const st2 = new URL(s2.headers.get('location')!).searchParams.get('state')!;
    fake.grantUser(7, 'code-m');
    const denied = await app.fetch(new Request(`https://n2.example/auth/callback?code=code-m&state=${st2}`, { headers: { cookie: s2.headers.get('set-cookie')!.split(';')[0]! } }), e);
    expect(denied.status).toBe(403);
  });
});
