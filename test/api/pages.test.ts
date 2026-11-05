import { SELF } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';
import type {
  Page,
  PageDetail,
  SearchResponse,
  TreeResponse,
  UploadedFile,
} from '../../src/shared/types';
import { login, ORIGIN, session } from './helpers';

const PNG = Uint8Array.from(
  atob(
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==',
  ),
  (c) => c.charCodeAt(0),
);

describe('auth', () => {
  it('requires a session and rejects wrong passwords', async () => {
    expect((await SELF.fetch(`${ORIGIN}/api/tree`)).status).toBe(401);
    expect((await login('wrong', '192.0.2.50')).status).toBe(401);
    expect((await SELF.fetch(`${ORIGIN}/files/img/abc.png`)).status).toBe(401);
  });
});

describe('pages', () => {
  it('creates a tree, moves pages and refuses cycles', async () => {
    const api = await session();
    const a = (await api.post<Page>('/pages', { title: 'Projects' })).data;
    const b = (await api.post<Page>('/pages', { title: 'Nitrogen', parent_id: a.id })).data;
    const c = (await api.post<Page>('/pages', { title: 'Roadmap', parent_id: b.id })).data;
    const first = (await api.post<Page>('/pages', { title: 'Alpha', parent_id: a.id, position: 0 }))
      .data;

    const detail = (await api.get<PageDetail>(`/pages/${c.id}`)).data;
    expect(detail.ancestors.map((p) => p.title)).toEqual(['Projects', 'Nitrogen']);
    const kids = (await api.get<PageDetail>(`/pages/${a.id}`)).data.children;
    expect(kids.map((k) => k.title)).toEqual(['Alpha', 'Nitrogen']);

    const cycle = await api.post(`/pages/${a.id}/move`, { parent_id: c.id });
    expect(cycle.status).toBe(400);

    await api.post(`/pages/${c.id}/move`, { parent_id: a.id, position: 0 });
    const after = (await api.get<PageDetail>(`/pages/${a.id}`)).data.children;
    expect(after.map((k) => k.title)).toEqual(['Roadmap', 'Alpha', 'Nitrogen']);
    expect(first.position).toBe(0);
  });

  it('detects edit conflicts', async () => {
    const api = await session();
    const p = (await api.post<Page>('/pages', { title: 'Doc', body: 'v1' })).data;
    const ok = await api.patch<Page>(`/pages/${p.id}`, { body: 'v2', base_version: 1 });
    expect(ok.data.version).toBe(2);
    const stale = await api.patch(`/pages/${p.id}`, { body: 'v2b', base_version: 1 });
    expect(stale.status).toBe(409);

    // Overwrite without base_version still works (the app's "Keep mine").
    expect((await api.patch<Page>(`/pages/${p.id}`, { body: 'v3' })).data.version).toBe(3);
  });

  it('links pages and lists backlinks', async () => {
    const api = await session();
    const target = (await api.post<Page>('/pages', { title: 'Glossary Term' })).data;
    const src = (
      await api.post<Page>('/pages', { title: 'Uses Term', body: 'See [[glossary term]].' })
    ).data;
    const d = (await api.get<PageDetail>(`/pages/${target.id}`)).data;
    expect(d.backlinks.map((b) => b.id)).toContain(src.id);
  });

  it('deletes a subtree', async () => {
    const api = await session();
    const root = (await api.post<Page>('/pages', { title: 'Temp' })).data;
    const child = (await api.post<Page>('/pages', { title: 'Temp child', parent_id: root.id }))
      .data;
    await api.post('/pages', { title: 'Temp grandchild', parent_id: child.id });
    const del = await api.del<{ deleted: number }>(`/pages/${root.id}`);
    expect(del.data.deleted).toBe(3);
    expect((await api.get(`/pages/${child.id}`)).status).toBe(404);
  });

  it('creates nested pages in one call', async () => {
    const api = await session();
    const res = await api.post<{ created: { id: string; title: string }[] }>('/pages/tree', {
      pages: [
        {
          title: 'Handbook',
          children: [{ title: 'Onboarding', body: 'See [[Handbook]].' }, { title: 'Policies' }],
        },
      ],
    });
    expect(res.status).toBe(201);
    expect(res.data.created.map((p) => p.title)).toEqual(['Handbook', 'Onboarding', 'Policies']);
    const hb = (await api.get<PageDetail>(`/pages/${res.data.created[0]!.id}`)).data;
    expect(hb.children.map((c) => c.title)).toEqual(['Onboarding', 'Policies']);
    expect(hb.backlinks.map((b) => b.title)).toEqual(['Onboarding']);
  });
});

describe('search', () => {
  it('finds pages by keyword and falls back when semantic search is unavailable', async () => {
    const api = await session();
    await api.post('/pages', { title: 'Sourdough starter', body: 'Feed the levain twice a day.' });
    const kw = (await api.get<SearchResponse>('/search?q=levain&mode=keyword')).data;
    expect(kw.hits[0]?.title).toBe('Sourdough starter');
    expect(kw.hits[0]?.snippet).toContain('\u0001levain\u0002');
    // AI Search does not run locally, so hybrid answers with keyword hits and says why.
    const hy = (await api.get<SearchResponse>('/search?q=levain&mode=hybrid')).data;
    expect(hy.hits[0]?.title).toBe('Sourdough starter');
  });
});

describe('images', () => {
  it('uploads to R2, serves to signed-in users only, and rejects non-images', async () => {
    const api = await session();
    const page = (await api.post<Page>('/pages', { title: 'Photos' })).data;
    const up = await SELF.fetch(`${ORIGIN}/api/files?page_id=${page.id}`, {
      method: 'POST',
      headers: {
        Cookie: api.cookie,
        Origin: ORIGIN,
        'Content-Type': 'image/png',
        'X-File-Name': 'dot.png',
      },
      body: PNG,
    });
    expect(up.status).toBe(201);
    const file = (await up.json()) as UploadedFile;
    expect(file.markdown).toBe(`![dot](${file.url})`);

    const got = await SELF.fetch(`${ORIGIN}${file.url}`, { headers: { Cookie: api.cookie } });
    expect(got.status).toBe(200);
    expect(got.headers.get('Content-Type')).toBe('image/png');
    expect(got.headers.get('Content-Security-Policy')).toContain('sandbox');
    expect(new Uint8Array(await got.arrayBuffer())).toEqual(PNG);
    expect((await SELF.fetch(`${ORIGIN}${file.url}`)).status).toBe(401);

    const svg = await SELF.fetch(`${ORIGIN}/api/files`, {
      method: 'POST',
      headers: { Cookie: api.cookie, Origin: ORIGIN, 'Content-Type': 'image/svg+xml' },
      body: '<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>',
    });
    expect(svg.status).toBe(415);
  });
});

describe('backup', () => {
  it('round-trips through restore', async () => {
    const api = await session();
    await api.post('/pages', { title: 'Keep me', body: 'hello' });
    const backup = (await api.get<{ pages: Page[] }>('/backup')).data;
    const n = backup.pages.length;
    expect((await api.post('/restore', backup)).status).toBe(200);
    const tree = (await api.get<TreeResponse>('/tree')).data;
    expect(tree.pages.length).toBe(n);
    expect(tree.pages.some((p) => p.title === 'Keep me')).toBe(true);
  });
});
