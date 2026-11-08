import { describe, expect, it } from 'vitest';
import type {
  Dashboard,
  Mention,
  Page,
  PageDetail,
  Revision,
  SearchResponse,
  TagCount,
} from '@shared/types';
import { session } from './helpers';

describe('tags', () => {
  it('combines page tags and #tags in the body, and filters search', async () => {
    const api = await session();
    const p = (
      await api.post<Page>('/pages', {
        title: 'Tag Source',
        body: 'Notes about #Gardening and `#notatag` and [x](#anchor).\n\n## Heading',
        tags: ['#Home Ideas', 'home-ideas'],
      })
    ).data;
    expect(p.tags).toEqual(['home-ideas']);
    const d = (await api.get<PageDetail>(`/pages/${p.id}`)).data;
    expect(d.all_tags).toEqual(['gardening', 'home-ideas']);

    const tags = (await api.get<{ tags: TagCount[] }>('/tags')).data.tags;
    expect(tags.find((t) => t.tag === 'gardening')?.count).toBe(1);

    const hits = (await api.get<SearchResponse>('/search?q=&tag=gardening')).data.hits;
    expect(hits.map((h) => h.id)).toEqual([p.id]);

    await api.patch(`/pages/${p.id}`, { body: 'No tags now.', tags: [] });
    expect((await api.get<PageDetail>(`/pages/${p.id}`)).data.all_tags).toEqual([]);
  });
});

describe('connections', () => {
  it('finds unlinked mentions and links them in one step', async () => {
    const api = await session();
    const target = (await api.post<Page>('/pages', { title: 'Compost Bins' })).data;
    const src = (
      await api.post<Page>('/pages', {
        title: 'Garden Log',
        body: 'Turned the compost bins today. `compost bins` in code is ignored.',
      })
    ).data;
    await api.post<Page>('/pages', { title: 'Linked Already', body: 'See [[Compost Bins]].' });

    const { mentions } = (await api.get<{ mentions: Mention[] }>(`/pages/${target.id}/mentions`))
      .data;
    expect(mentions.map((m) => m.title)).toEqual(['Garden Log']);
    expect(mentions[0]!.snippet).toContain('compost bins');

    expect((await api.post(`/pages/${target.id}/mentions/link`, { src: src.id })).status).toBe(200);
    const after = (await api.get<PageDetail>(`/pages/${src.id}`)).data.page.body;
    expect(after).toBe(
      'Turned the [[Compost Bins|compost bins]] today. `compost bins` in code is ignored.',
    );
    const back = (await api.get<PageDetail>(`/pages/${target.id}`)).data.backlinks;
    expect(back.map((b) => b.title).sort()).toEqual(['Garden Log', 'Linked Already']);
  });
});

describe('dashboard', () => {
  it('pins pages, attributes edits to you, and keeps settings', async () => {
    const api = await session();
    const p = (await api.post<Page>('/pages', { title: 'Pin Me', body: 'one two three' })).data;
    expect(p.created_by).toBe('you');
    expect(p.words).toBe(3);
    await api.post(`/pages/${p.id}/pin`, { pinned: true });
    const dash = (await api.get<Dashboard>('/dashboard')).data;
    expect(dash.pinned.map((x) => x.id)).toContain(p.id);
    expect(dash.inbox.some((x) => x.id === p.id)).toBe(false);
    expect(dash.activity[0]!.page_id).toBe(p.id);
    expect(dash.stats.pages).toBeGreaterThan(0);

    const layout = [
      { id: 'pinned', size: 'half', hidden: false },
      { id: 'stats', size: 'full', hidden: true },
    ];
    expect((await api.patch('/settings', { dashboard_layout: layout })).status).toBe(200);
    const saved = (await api.get<{ dashboard_layout: unknown }>('/settings')).data;
    expect(saved.dashboard_layout).toEqual(layout);
    expect(
      (await api.patch('/settings', { insights_layout: [{ id: 'x', size: 'wide', hidden: 0 }] }))
        .status,
    ).toBe(400);

    // History records who wrote each version.
    await api.patch(`/pages/${p.id}`, { body: 'changed' });
    const v = (await api.get<{ revisions: Revision[] }>(`/pages/${p.id}/revisions`)).data;
    expect(v.revisions.every((r) => r.actor === 'you' || r.actor === null)).toBe(true);
  });
});
