import { describe, expect, it } from 'vitest';
import { setup } from './helpers.ts';
import { gitBlobSha } from '../src/util/crypto.ts';
import { app } from '../src/app.ts';

type J = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any

describe('auth', () => {
  it('rejects requests without a session', async () => {
    const { env } = await setup();
    const res = await app.fetch(new Request('https://n2.example/api/tree'), env);
    expect(res.status).toBe(401);
  });
  it('rejects mutating requests without CSRF', async () => {
    const { call } = await setup();
    const r = await call('POST', '/api/commit', { changes: [] }, { 'x-csrf-token': 'nope' });
    expect(r.status).toBe(403);
  });
  it('health reports booleans only', async () => {
    const { env } = await setup();
    const res = await app.fetch(new Request('https://n2.example/api/health'), env);
    const j = (await res.json()) as J;
    expect(j.secrets.SESSION_SECRET).toBe(true);
    expect(JSON.stringify(j)).not.toContain('test-session-secret');
    expect(res.headers.get('strict-transport-security')).toContain('max-age');
  });
});

describe('index bootstrap and reads', () => {
  it('indexes the repo on first tree load and serves pages with backlinks', async () => {
    const { call } = await setup();
    const t = await call('GET', '/api/tree');
    expect(t.status).toBe(200);
    expect((t.json as J).pages.map((p: J) => p.path).sort()).toEqual(['architecture/index.md', 'architecture/sync-design.md', 'decisions/adr-1.md', 'index.md']);
    const p = (await call('GET', '/api/page?path=architecture/sync-design.md')).json as J;
    expect(p.content).toContain('# Sync design');
    expect(p.meta.aliases).toEqual(['Commit pipeline']);
    expect(p.outline.map((h: J) => h.slug)).toEqual(['sync-design', 'commit-flow']);
    const groups = p.backlinks as J[];
    expect(groups.map((g) => g.path).sort()).toEqual(['architecture/index.md', 'decisions/adr-1.md', 'index.md']);
    const adr = groups.find((g) => g.path === 'decisions/adr-1.md')!;
    expect(adr.links[0]).toMatchObject({ rel: 'implements', frag: 'commit-flow' });
    expect(adr.links[0].ctx).toContain('Implements the sync design');
  });

  it('searches with FTS5, prefix and filters', async () => {
    const { call } = await setup();
    await call('GET', '/api/tree');
    const r = (await call('GET', '/api/search?q=commi')).json as J;
    expect(r.results[0].path).toBe('architecture/sync-design.md');
    expect(r.results[0].snippet).toContain('<mark>');
    const f = (await call('GET', '/api/search?q=sync%20status:active')).json as J;
    expect(f.results.map((x: J) => x.path)).toEqual(['decisions/adr-1.md']);
  });

  it('serves blobs with immutable caching by sha', async () => {
    const { call } = await setup();
    await call('GET', '/api/tree');
    const sha = await gitBlobSha('PNGDATA');
    const r = await call('GET', `/api/blob?path=images/a.png&sha=${sha}`);
    expect(r.status).toBe(200);
    expect(r.res.headers.get('content-type')).toBe('image/png');
    expect(r.res.headers.get('cache-control')).toContain('immutable');
  });

  it('link explorer queries', async () => {
    const { call } = await setup();
    await call('GET', '/api/tree');
    const m = (await call('GET', '/api/matrix?rows=under:decisions&cols=under:architecture')).json as J;
    expect(m.cells).toEqual([{ src: 'decisions/adr-1.md', dst: 'architecture/sync-design.md', n: 1 }]);
    expect(m.emptyCols).toEqual(['architecture/index.md']);
    const filtered = (await call('GET', '/api/matrix?rows=under:decisions&cols=under:architecture&rel=cites')).json as J;
    expect(filtered.cells).toEqual([]);
    const n = (await call('GET', '/api/neighborhood?page=architecture/sync-design.md')).json as J;
    expect(n.nodes.length).toBe(4);
    expect(n.edges.find((e: J) => e.src === 'decisions/adr-1.md').rel).toBe('implements');
    const cmp = (await call('GET', '/api/compare?a=architecture/sync-design.md&b=decisions/adr-1.md')).json as J;
    expect(cmp.coCitation.map((x: J) => x.path)).toEqual(['index.md']);
    expect(cmp.path.map((x: J) => x.path)).toEqual(['architecture/sync-design.md', 'decisions/adr-1.md']);
    const u = (await call('GET', '/api/unlinked?page=architecture/sync-design.md')).json as J;
    expect(u.mentions).toEqual([]);
    const links = (await call('GET', '/api/links?page=architecture/sync-design.md&dir=in&rel=implements')).json as J;
    expect(links.incoming.map((g: J) => g.path)).toEqual(['decisions/adr-1.md']);
  });
});

describe('commit pipeline', () => {
  it('bundles three files in one commit with trailers and updates the index', async () => {
    const { call, fake } = await setup();
    await call('GET', '/api/tree');
    const before = fake.head();
    const shaHome = fake.files().get('index.md')!;
    const r = await call('POST', '/api/commit', {
      changes: [
        { path: 'index.md', op: 'put', content: '# Home\n\nNew home. [New](/notes/new.md)\n', baseSha: shaHome },
        { path: 'notes/new.md', op: 'put', content: '# New\n\nMentions Sync design here.\n', baseSha: null },
        { path: 'decisions/adr-1.md', op: 'delete', baseSha: fake.files().get('decisions/adr-1.md') },
      ],
    });
    expect(r.status).toBe(200);
    const j = r.json as J;
    expect(fake.commitObj(fake.head()).parents).toEqual([before]);
    expect(fake.log().length).toBe(2);
    const msg = fake.commitObj(fake.head()).message;
    expect(msg).toMatch(/^nitrogen: update index\.md \(\+2 more\)/);
    expect(msg).toContain('Nitrogen-Actor: human');
    expect(msg).toContain('Nitrogen-Client: web');
    expect(fake.read('notes/new.md')).toContain('# New');
    expect(fake.read('decisions/adr-1.md')).toBeNull();
    expect(j.results.find((x: J) => x.path === 'notes/new.md').sha).toBe(fake.files().get('notes/new.md'));
    const tree = (await call('GET', '/api/tree')).json as J;
    expect(tree.pages.map((p: J) => p.path)).toContain('notes/new.md');
    expect(tree.pages.map((p: J) => p.path)).not.toContain('decisions/adr-1.md');
    const back = (await call('GET', '/api/backlinks?path=notes/new.md')).json as J;
    expect(back.backlinks[0].path).toBe('index.md');
    const act = (await call('GET', '/api/activity')).json as J;
    expect(act.activity[0]).toMatchObject({ actor: 'human', client: 'web', files: 3 });
    const unl = (await call('GET', '/api/unlinked?page=architecture/sync-design.md')).json as J;
    expect(unl.mentions.map((m: J) => m.path)).toEqual(['notes/new.md']);
  });

  it('returns 409 with the remote content when baseSha is stale', async () => {
    const { call, fake } = await setup();
    const stale = fake.files().get('index.md')!;
    fake.push({ 'index.md': '# Home\n\nEdited on a laptop.\n' });
    const r = await call('POST', '/api/commit', { changes: [{ path: 'index.md', op: 'put', content: 'mine', baseSha: stale }] });
    expect(r.status).toBe(409);
    const c = (r.json as J).conflicts[0];
    expect(c).toMatchObject({ path: 'index.md', theirsSha: fake.files().get('index.md') });
    expect(c.theirs).toContain('Edited on a laptop');
  });

  it('fast-forwards onto unrelated remote changes, including a race during the ref update', async () => {
    const { call, fake } = await setup();
    const base = fake.files().get('architecture/index.md')!;
    fake.push({ 'other.md': '# Other\n' });
    fake.beforeRefUpdate = () => fake.push({ 'race.md': '# Race\n' }, 'concurrent push');
    const r = await call('POST', '/api/commit', { changes: [{ path: 'architecture/index.md', op: 'put', content: '# Arch v2\n', baseSha: base }] });
    expect(r.status).toBe(200);
    expect(fake.read('race.md')).toBe('# Race\n');
    expect(fake.read('other.md')).toBe('# Other\n');
    expect(fake.read('architecture/index.md')).toBe('# Arch v2\n');
    const patches = fake.requests.filter((x) => x.method === 'PATCH');
    expect(patches.length).toBe(2);
    expect(patches.every((p) => (p.body as J).force === false)).toBe(true);
  });

  it('move rewrites inbound links in the same commit', async () => {
    const { call, fake } = await setup();
    await call('GET', '/api/tree');
    const r = await call('POST', '/api/commit', { changes: [{ path: 'architecture/sync-design.md', op: 'move', to: 'design/sync.md' }] });
    expect(r.status).toBe(200);
    expect(fake.log().length).toBe(2);
    expect(fake.read('architecture/sync-design.md')).toBeNull();
    expect(fake.read('design/sync.md')).toContain('# Sync design');
    expect(fake.read('index.md')).toContain('[Sync design](/design/sync.md)');
    expect(fake.read('decisions/adr-1.md')).toContain('(/design/sync.md#commit-flow "rel:implements")');
    expect(fake.read('architecture/index.md')).toContain('(/design/sync.md "rel:depends-on")');
    expect((r.json as J).rewritten.sort()).toEqual(['architecture/index.md', 'decisions/adr-1.md', 'index.md']);
    const back = (await call('GET', '/api/backlinks?path=design/sync.md')).json as J;
    expect(back.backlinks.length).toBe(3);
  });

  it('refuses paths outside the content root (E009) and oversize commits', async () => {
    const { call } = await setup();
    for (const path of ['.github/workflows/x.md', '../x.md', '.nitrogen/config.yml', 'images/x.md']) {
      const r = await call('POST', '/api/commit', { changes: [{ path, op: 'put', content: 'x' }] });
      expect(r.status, path).toBe(422);
      expect((r.json as J).code).toBe('E009');
    }
    const many = Array.from({ length: 31 }, (_, i) => ({ path: `p${i}.md`, op: 'put', content: 'x' }));
    expect((await call('POST', '/api/commit', { changes: many })).status).toBe(413);
  });

  it('reverts a commit and conflicts when the file changed since', async () => {
    const { call, fake } = await setup();
    const sha = fake.files().get('index.md')!;
    const c1 = (await call('POST', '/api/commit', { changes: [{ path: 'index.md', op: 'put', content: '# Changed\n', baseSha: sha }] })).json as J;
    const rv = await call('POST', '/api/revert', { sha: c1.commitSha });
    expect(rv.status).toBe(200);
    expect(fake.read('index.md')).toContain('See [Sync design]');
    expect(fake.commitObj(fake.head()).message).toMatch(/^Revert "nitrogen: update index\.md"/);
    const c2 = (await call('POST', '/api/commit', { changes: [{ path: 'index.md', op: 'put', content: '# A\n', baseSha: fake.files().get('index.md') }] })).json as J;
    fake.push({ 'index.md': '# B\n' });
    expect((await call('POST', '/api/revert', { sha: c2.commitSha })).status).toBe(409);
  });

  it('history parses actor trailers', async () => {
    const { call, fake } = await setup();
    await call('POST', '/api/commit', { changes: [{ path: 'index.md', op: 'put', content: '# H\n', baseSha: fake.files().get('index.md') }] });
    const h = (await call('GET', '/api/history?path=index.md')).json as J;
    expect(h.commits[0]).toMatchObject({ actor: 'human', client: 'web' });
    expect(h.commits[1]).toMatchObject({ actor: 'external' });
  });
});

describe('freshness', () => {
  it('changes endpoint reports remote edits and reindexes them', async () => {
    const { call, fake } = await setup();
    const t = (await call('GET', '/api/tree')).json as J;
    fake.push({ 'architecture/sync-design.md': '# Sync design\n\nRewritten with [ADR](/decisions/adr-1.md).\n', 'fresh.md': '# Fresh\n' });
    const ch = (await call('GET', `/api/changes?since=${t.head}`)).json as J;
    expect(ch.head).toBe(fake.head());
    expect(ch.changed.map((x: J) => x.path).sort()).toEqual(['architecture/sync-design.md', 'fresh.md']);
    // drain ran (no execution ctx in tests -> inline)
    const tree = (await call('GET', '/api/tree')).json as J;
    expect(tree.pages.map((p: J) => p.path)).toContain('fresh.md');
    const out = (await call('GET', '/api/links?page=architecture/sync-design.md&dir=out')).json as J;
    expect(out.outgoing.map((g: J) => g.path)).toEqual(['decisions/adr-1.md']);
  });
});
