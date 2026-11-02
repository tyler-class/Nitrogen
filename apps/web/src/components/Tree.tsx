import React, { useEffect, useMemo, useRef, useState, type KeyboardEvent } from 'react';
import { useNavigate } from '@tanstack/react-router';
import { ancestorsOf, pageHref, visibleRows, type TreeNode } from '../lib/tree.ts';
import { Icon, PageGlyph } from './Icon.tsx';
import { getKV, setKV } from '../lib/db.ts';

/**
 * ARIA tree with roving tabindex: Up/Down move, Right expands or enters, Left collapses or goes to
 * the parent, Home/End, Enter opens. Expanded state persists in IndexedDB. Long lists rely on
 * `content-visibility: auto` per row (see DECISIONS ADR-019).
 */
export function Tree({ root, active, onNavigate, onContext }: { root: TreeNode; active: string | null; onNavigate?: () => void; onContext?: (n: TreeNode, x: number, y: number) => void }) {
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [focusId, setFocusId] = useState<string | null>(null);
  const loaded = useRef(false);
  const navigate = useNavigate();
  const listRef = useRef<HTMLUListElement>(null);

  useEffect(() => {
    void getKV<string[]>('tree-expanded', []).then((v) => {
      setExpanded((cur) => new Set([...cur, ...v]));
      loaded.current = true;
    });
  }, []);
  useEffect(() => {
    if (!active) return;
    setExpanded((cur) => {
      const add = ancestorsOf(active).filter((a) => !cur.has(a));
      return add.length ? new Set([...cur, ...add]) : cur;
    });
  }, [active]);
  useEffect(() => {
    if (loaded.current) void setKV('tree-expanded', [...expanded]);
  }, [expanded]);

  const rows = useMemo(() => visibleRows(root, expanded), [root, expanded]);
  const current = focusId ?? rows.find((r) => r.node.page === active)?.node.id ?? rows[0]?.node.id ?? null;

  const toggle = (id: string, open?: boolean) =>
    setExpanded((cur) => {
      const n = new Set(cur);
      if (open ?? !n.has(id)) n.add(id);
      else n.delete(id);
      return n;
    });

  const open = (n: TreeNode) => {
    if (n.page) {
      void navigate({ to: '/p/$', params: { _splat: n.page } });
      onNavigate?.();
    } else toggle(n.id);
  };

  const focusRow = (id: string) => {
    setFocusId(id);
    requestAnimationFrame(() => (listRef.current?.querySelector(`[data-id="${CSS.escape(id)}"]`) as HTMLElement | null)?.focus());
  };

  const onKey = (e: KeyboardEvent, i: number) => {
    const r = rows[i]!;
    const n = r.node;
    switch (e.key) {
      case 'ArrowDown':
        if (rows[i + 1]) focusRow(rows[i + 1]!.node.id);
        break;
      case 'ArrowUp':
        if (rows[i - 1]) focusRow(rows[i - 1]!.node.id);
        break;
      case 'ArrowRight':
        if (n.kind === 'folder') {
          if (!expanded.has(n.id)) toggle(n.id, true);
          else if (rows[i + 1] && rows[i + 1]!.depth > r.depth) focusRow(rows[i + 1]!.node.id);
        }
        break;
      case 'ArrowLeft':
        if (n.kind === 'folder' && expanded.has(n.id)) toggle(n.id, false);
        else {
          for (let j = i - 1; j >= 0; j--) if (rows[j]!.depth < r.depth) return focusRow(rows[j]!.node.id);
        }
        break;
      case 'Home':
        if (rows[0]) focusRow(rows[0].node.id);
        break;
      case 'End':
        if (rows.length) focusRow(rows[rows.length - 1]!.node.id);
        break;
      case 'Enter':
      case ' ':
        open(n);
        break;
      case 'ContextMenu':
      case 'F10':
        if (e.key === 'ContextMenu' || e.shiftKey) {
          const rect = (e.currentTarget as HTMLElement).getBoundingClientRect();
          onContext?.(n, rect.left + 24, rect.bottom);
        } else return;
        break;
      default:
        return;
    }
    e.preventDefault();
  };

  // Render nested markup (for indent guides) from the flat rows.
  const render = (parent: TreeNode, depth: number): React.ReactElement[] =>
    parent.children.map((n) => {
      const i = rows.findIndex((r) => r.node === n);
      const isFolder = n.kind === 'folder';
      const isOpen = expanded.has(n.id);
      let pressTimer: ReturnType<typeof setTimeout> | undefined;
      return (
        <li key={n.id} role="none" style={{ contentVisibility: 'auto', containIntrinsicSize: 'auto 30px' } as React.CSSProperties}>
          <a
            href={n.page ? pageHref(n.page) : undefined}
            role="treeitem"
            data-id={n.id}
            className="tree-row"
            tabIndex={n.id === current ? 0 : -1}
            aria-level={depth + 1}
            aria-expanded={isFolder && n.children.length ? isOpen : undefined}
            aria-current={n.page && n.page === active ? 'page' : undefined}
            aria-selected={n.page === active}
            onClick={(e) => {
              if (e.metaKey || e.ctrlKey) return;
              e.preventDefault();
              setFocusId(n.id);
              open(n);
            }}
            onKeyDown={(e) => onKey(e, i)}
            onContextMenu={(e) => {
              if (!onContext) return;
              e.preventDefault();
              onContext(n, e.clientX, e.clientY);
            }}
            onTouchStart={(e) => {
              const t = e.touches[0]!;
              pressTimer = setTimeout(() => onContext?.(n, t.clientX, t.clientY), 550);
            }}
            onTouchEnd={() => clearTimeout(pressTimer)}
            onTouchMove={() => clearTimeout(pressTimer)}
          >
            {isFolder && n.children.length ? (
              <span
                className="twisty"
                aria-hidden
                onClick={(e) => {
                  e.preventDefault();
                  e.stopPropagation();
                  toggle(n.id);
                }}
              >
                <Icon name="chevron" size={12} />
              </span>
            ) : (
              <span className="twisty" aria-hidden />
            )}
            <PageGlyph icon={n.icon} folder={isFolder} />
            <span className="label">{n.title}</span>
            {(n.status === 'draft' || n.status === 'archived') && <span className={`status-dot ${n.status}`} title={n.status} />}
          </a>
          {isFolder && isOpen && n.children.length > 0 && (
            <ul role="group">{render(n, depth + 1)}</ul>
          )}
        </li>
      );
    });

  return (
    <ul className="tree" role="tree" aria-label="Pages" ref={listRef}>
      {render(root, 0)}
    </ul>
  );
}
