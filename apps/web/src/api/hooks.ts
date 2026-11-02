import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect, useMemo } from 'react';
import { DEFAULT_CONFIG, type VaultContext } from '@nitrogen/core';
import { api, qs } from './client.ts';
import type { ActivityRow, LinkGroup, Me, PageResponse, TreeResponse } from './types.ts';
import { db, setKV, getKV } from '../lib/db.ts';

export function useMe() {
  return useQuery({ queryKey: ['me'], queryFn: () => api<Me>('/me'), staleTime: 5 * 60_000, retry: false });
}

export function useTree() {
  return useQuery({
    queryKey: ['tree'],
    queryFn: async () => {
      try {
        const t = await api<TreeResponse>('/tree');
        void setKV('tree', t);
        return t;
      } catch (e) {
        const cached = await getKV<TreeResponse | null>('tree', null);
        if (cached && !navigator.onLine) return cached;
        throw e;
      }
    },
    staleTime: 30_000,
  });
}

export function useImages() {
  return useQuery({ queryKey: ['images'], queryFn: () => api<{ images: { path: string; sha: string; size: number }[] }>('/images'), staleTime: 60_000 });
}

/** VaultContext for client-side rendering and lint (titles, aliases, images). */
export function useVaultContext(): VaultContext | null {
  const tree = useTree();
  const images = useImages();
  return useMemo(() => {
    if (!tree.data) return null;
    return {
      config: { ...DEFAULT_CONFIG, ...tree.data.config, actors: tree.data.config.actors ?? DEFAULT_CONFIG.actors } as VaultContext['config'],
      pages: tree.data.pages.map((p) => ({ path: p.path, title: p.title, aliases: p.aliases })),
      images: images.data?.images.map((i) => i.path) ?? [],
    };
  }, [tree.data, images.data]);
}

export function usePage(path: string) {
  return useQuery({
    queryKey: ['page', path],
    queryFn: async () => {
      try {
        const p = await api<PageResponse>(`/page${qs({ path })}`);
        void db.pages.put({ path, sha: p.sha, content: p.content, fetchedAt: Date.now() }).catch(() => {});
        void setKV(`page-extra:${path}`, { meta: p.meta, backlinks: p.backlinks, outline: p.outline });
        return p;
      } catch (e) {
        const cached = await db.pages.get(path).catch(() => undefined);
        if (cached) {
          const extra = await getKV<Partial<PageResponse>>(`page-extra:${path}`, {});
          return { path, sha: cached.sha, content: cached.content, meta: extra.meta, backlinks: extra.backlinks ?? [], outline: extra.outline ?? [], offline: true } as PageResponse & { offline: true };
        }
        throw e;
      }
    },
    enabled: !!path,
    staleTime: 15_000,
  });
}

export function useBacklinks(path: string, rel?: string[]) {
  return useQuery({ queryKey: ['backlinks', path, rel], queryFn: () => api<{ backlinks: LinkGroup[] }>(`/backlinks${qs({ path, rel })}`), enabled: !!path });
}

export function useActivity(actor?: string) {
  return useQuery({ queryKey: ['activity', actor], queryFn: () => api<{ activity: ActivityRow[] }>(`/activity${qs({ actor })}`) });
}

/**
 * Pull: poll /api/changes every 20 s while visible, 60 s hidden, immediately on focus/online.
 * Invalidates the tree and changed pages. Returns nothing; emits `n2:remote-change` events.
 */
export function useChangesPoll() {
  const qc = useQueryClient();
  const tree = useTree();
  const head = tree.data?.head ?? null;
  useEffect(() => {
    if (!head) return;
    let since = head;
    let timer: ReturnType<typeof setTimeout>;
    let stopped = false;
    const tick = async () => {
      if (stopped) return;
      try {
        if (navigator.onLine) {
          const r = await api<{ head: string | null; changed: { path: string; status: string }[]; reset?: boolean }>(`/changes${qs({ since })}`);
          if (r.head && r.head !== since) {
            since = r.head;
            await qc.invalidateQueries({ queryKey: ['tree'] });
            await qc.invalidateQueries({ queryKey: ['activity'] });
            const paths = r.reset ? null : r.changed.map((c) => c.path);
            await qc.invalidateQueries({ predicate: (q) => q.queryKey[0] === 'page' && (paths === null || paths.includes(String(q.queryKey[1]))) });
            await qc.invalidateQueries({ queryKey: ['backlinks'] });
            window.dispatchEvent(new CustomEvent('n2:remote-change', { detail: { head: r.head, paths } }));
          }
        }
      } catch {
        /* offline or signed out; retry later */
      }
      timer = setTimeout(tick, document.visibilityState === 'visible' ? 20_000 : 60_000);
    };
    timer = setTimeout(tick, 20_000);
    const now = () => {
      clearTimeout(timer);
      void tick();
    };
    window.addEventListener('focus', now);
    window.addEventListener('online', now);
    return () => {
      stopped = true;
      clearTimeout(timer);
      window.removeEventListener('focus', now);
      window.removeEventListener('online', now);
    };
  }, [head, qc]);
}
