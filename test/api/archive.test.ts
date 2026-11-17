import { describe, expect, it } from 'vitest';
import type { Mention, OpenItem, Page, PageDetail, TreeResponse } from '@shared/types';
import { session } from './helpers';

describe('archive', () => {
  it('archives a branch out of the tree and open items, and restores it', async () => {
    const api = await session();
    const parent = (
      await api.post<Page>('/pages', { title: 'Old Project', body: '- [ ] todo: Wrap up' })
    ).data;
    const child = (
      await api.post<Page>('/pages', {
        title: 'Old Notes',
        parent_id: parent.id,
        body: '- question: Still needed?',
      })
    ).data;

    const res = await api.post<Page>(`/pages/${parent.id}/archive`, { archived: true });
    expect(res.status).toBe(200);
    expect(res.data.archived_at).toBeTruthy();

    const tree = (await api.get<TreeResponse>('/tree')).data;
    expect(tree.pages.map((p) => p.id)).not.toContain(parent.id);
    expect(tree.pages.map((p) => p.id)).not.toContain(child.id);
    expect(tree.archived.map((p) => p.id).sort()).toEqual([parent.id, child.id].sort());

    const items = (await api.get<{ items: OpenItem[] }>('/items')).data.items;
    expect(items.some((i) => i.page_id === parent.id || i.page_id === child.id)).toBe(false);

    // Still readable by id (links to it keep working).
    const d = (await api.get<PageDetail>(`/pages/${child.id}`)).data;
    expect(d.page.archived_at).toBeTruthy();

    // Restoring the child brings back its parent too, so it has a place in the tree.
    await api.post(`/pages/${child.id}/archive`, { archived: false });
    const after = (await api.get<TreeResponse>('/tree')).data;
    expect(after.pages.map((p) => p.id)).toEqual(expect.arrayContaining([parent.id, child.id]));
    expect(after.archived).toEqual([]);
  });

  it('refuses to archive AI Instructions', async () => {
    const api = await session();
    const { id } = (await api.get<{ id: string }>('/ai-instructions')).data;
    expect((await api.post(`/pages/${id}/archive`, { archived: true })).status).toBe(403);
  });
});

describe('items', () => {
  it('deletes an item line and returns it for undo', async () => {
    const api = await session();
    const p = (
      await api.post<Page>('/pages', {
        title: 'Chores',
        body: 'Intro\n- [ ] todo: Sweep\n- [ ] todo: Mop',
      })
    ).data;
    const res = await api.post<Page & { removed: string }>(`/pages/${p.id}/items/delete`, {
      line: 2,
    });
    expect(res.status).toBe(200);
    expect(res.data.body).toBe('Intro\n- [ ] todo: Mop');
    expect(res.data.removed).toBe('- [ ] todo: Sweep');
    // Not an item line.
    expect((await api.post(`/pages/${p.id}/items/delete`, { line: 1 })).status).toBe(409);
  });
});

describe('mentions', () => {
  it('leaves out the page’s own branch and keeps the five that name it most', async () => {
    const api = await session();
    const target = (await api.post<Page>('/pages', { title: 'Seed Library' })).data;
    await api.post<Page>('/pages', {
      title: 'Inside It',
      parent_id: target.id,
      body: 'The seed library opens in May.',
    });
    for (let n = 1; n <= 6; n++)
      await api.post<Page>('/pages', {
        title: `Elsewhere ${n}`,
        body: Array.from({ length: n }, () => 'The seed library.').join(' '),
      });
    const { mentions } = (await api.get<{ mentions: Mention[] }>(`/pages/${target.id}/mentions`))
      .data;
    expect(mentions.map((m) => m.title)).toEqual([
      'Elsewhere 6',
      'Elsewhere 5',
      'Elsewhere 4',
      'Elsewhere 3',
      'Elsewhere 2',
    ]);
  });
});
