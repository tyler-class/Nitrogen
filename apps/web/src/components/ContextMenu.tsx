import { useEffect, useRef } from 'react';
import { createPortal } from 'react-dom';
import { useNavigate } from '@tanstack/react-router';
import { useQueryClient } from '@tanstack/react-query';
import type { TreeNode } from '../lib/tree.ts';
import { pageHref } from '../lib/tree.ts';
import { api } from '../api/client.ts';
import { toast } from '../lib/toast.ts';
import { setFrontmatterKey } from '@nitrogen/core';

/** Tree context menu (right-click, long-press, Shift+F10). */
export function ContextMenu({ node, x, y, onClose }: { node: TreeNode; x: number; y: number; onClose: () => void }) {
  const ref = useRef<HTMLDivElement>(null);
  const navigate = useNavigate();
  const qc = useQueryClient();
  useEffect(() => {
    (ref.current?.querySelector('button') as HTMLButtonElement | null)?.focus();
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && onClose();
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);
  const page = node.page;
  const dir = node.kind === 'folder' ? node.id : node.id.includes('/') ? node.id.slice(0, node.id.lastIndexOf('/')) : '';
  const act = (fn: () => void | Promise<void>) => async () => {
    onClose();
    try {
      await fn();
    } catch (e) {
      toast((e as Error).message);
    }
  };
  const items: [string, () => void, boolean?][] = [
    ['New subpage', act(() => navigate({ to: '/new', search: { dir: node.kind === 'folder' ? node.id : node.id.replace(/\.md$/, '') } }))],
    ['Rename or move', act(() => navigate({ to: '/move', search: { path: page ?? '' } })), !page],
    [
      'Pin',
      act(async () => {
        const p = await api<{ content: string; sha: string }>(`/page?path=${encodeURIComponent(page!)}&include=content`);
        const pinned = /^pinned:\s*true/m.test(p.content);
        await api('/commit', { method: 'POST', json: { changes: [{ path: page, op: 'put', content: setFrontmatterKey(p.content, 'pinned', !pinned), baseSha: p.sha }], message: `nitrogen: ${pinned ? 'unpin' : 'pin'} ${page}` } });
        toast(pinned ? 'Unpinned.' : 'Pinned.');
        await qc.invalidateQueries({ queryKey: ['tree'] });
      }),
      !page,
    ],
    ['Copy link', act(() => navigator.clipboard.writeText(`${location.origin}${pageHref(page!)}`).then(() => toast('Link copied.'))), !page],
    ['Show links', act(() => navigate({ to: '/links', search: { page: page! } })), !page],
    ['Export standard', act(() => navigate({ to: '/export', search: { path: page ?? dir } }))],
    [
      'Delete',
      act(async () => {
        if (!confirm(`Delete ${page}? This creates a commit you can revert.`)) return;
        const p = await api<{ sha: string }>(`/page?path=${encodeURIComponent(page!)}&include=meta`);
        await api('/commit', { method: 'POST', json: { changes: [{ path: page, op: 'delete', baseSha: p.sha }] } });
        toast('Deleted. Revert it from Activity.');
        await qc.invalidateQueries({ queryKey: ['tree'] });
        void navigate({ to: '/' });
      }),
      !page,
    ],
  ];
  return createPortal(
    <>
      <div className="scrim" style={{ background: 'transparent' }} onClick={onClose} />
      <div ref={ref} role="menu" aria-label={`${node.title} actions`} style={{ position: 'fixed', left: Math.min(x, innerWidth - 220), top: Math.min(y, innerHeight - 300), zIndex: 60, background: 'var(--paper)', boxShadow: 'var(--shadow)', borderRadius: 8, padding: 4, minWidth: 200 }}>
        {items
          .filter(([, , hidden]) => !hidden)
          .map(([label, fn]) => (
            <button key={label} role="menuitem" className="tree-row" style={{ width: '100%', color: label === 'Delete' ? 'var(--danger)' : undefined }} onClick={fn}
              onKeyDown={(e) => {
                const all = [...ref.current!.querySelectorAll('button')];
                const i = all.indexOf(e.currentTarget);
                if (e.key === 'ArrowDown') all[(i + 1) % all.length]?.focus();
                if (e.key === 'ArrowUp') all[(i - 1 + all.length) % all.length]?.focus();
              }}>
              {label}
            </button>
          ))}
      </div>
    </>,
    document.body,
  );
}
