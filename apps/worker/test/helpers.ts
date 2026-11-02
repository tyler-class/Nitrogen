import { env } from 'cloudflare:test';
import { FakeGitHub, type FakeGitHubOptions } from '@nitrogen/testing';
import { app } from '../src/app.ts';
import type { Env } from '../src/env.ts';
import { sign } from '../src/auth/session.ts';
import { resetRepoCaches } from '../src/repo/service.ts';

export const DEMO: Record<string, string> = {
  '.nitrogen/config.yml': 'version: 1\nassets_dir: images\n',
  'index.md': '---\ntitle: Home\npinned: true\n---\n# Home\n\nSee [Sync design](/architecture/sync-design.md) and [ADR](/decisions/adr-1.md "rel:cites").\n',
  'architecture/index.md': '# Architecture\n\n[Sync](/architecture/sync-design.md "rel:depends-on")\n',
  'architecture/sync-design.md': '---\ntitle: Sync design\naliases: [Commit pipeline]\ntags: [sync]\n---\n# Sync design\n\n## Commit flow\n\nBody about commits. Links to [home](/index.md).\n',
  'decisions/adr-1.md': '---\ntitle: ADR-1\nstatus: active\n---\n# ADR-1\n\nImplements [the sync design](/architecture/sync-design.md#commit-flow "rel:implements"). The Sync design matters.\n',
  'images/a.png': 'PNGDATA',
};

export async function resetDb(): Promise<void> {
  const db = (env as unknown as Env).DB;
  await db.batch(
    ['pages', 'links', 'images', 'headings', 'assets', 'pages_fts', 'activity', 'meta', 'reindex_queue', 'rate'].map((t) => db.prepare(`DELETE FROM ${t}`)),
  );
}

export async function setup(opts: FakeGitHubOptions = {}) {
  resetRepoCaches();
  await resetDb();
  const fake = new FakeGitHub({ files: DEMO, ...opts });
  const e: Env = { ...(env as unknown as Env), GITHUB_FETCH: fake.fetch };
  const now = Math.floor(Date.now() / 1000);
  const session = await sign(e, { id: 1001, login: 'octo', iat: now, exp: now + 3600 });
  const cookie = `n2_session=${session}; n2_csrf=csrf123`;
  const call = async (method: string, path: string, body?: unknown, headers: Record<string, string> = {}) => {
    const res = await app.fetch(
      new Request(`https://n2.example${path}`, {
        method,
        headers: { cookie, 'x-csrf-token': 'csrf123', origin: 'https://n2.example', ...(body !== undefined ? { 'content-type': 'application/json' } : {}), ...headers },
        ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
      }),
      e,
    );
    const text = await res.text();
    let json: unknown = null;
    try {
      json = JSON.parse(text);
    } catch {
      json = text;
    }
    return { status: res.status, json: json as Record<string, unknown> & { [k: string]: never }, res };
  };
  return { fake, env: e, call, cookie };
}
