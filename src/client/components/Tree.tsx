// The page tree. Drag a page onto another to nest it, or onto the top/bottom edge of a row to
// reorder. Hover a row for "add subpage" and the page menu.
import { useEffect, useMemo, useRef, useState, type DragEvent } from 'react';
import { NavLink, useNavigate } from 'react-router';
import { pageHref } from '@shared/markdown';
import { ancestorsOf, buildTree, type TreeNode } from '@shared/tree';
import type { PageSummary } from '@shared/types';
import { errorMessage } from '../lib/api';
import { readLocal, writeLocal } from '../lib/storage';
import { useCreatePage, useDeletePage, useMovePage, useRenamePage } from '../lib/queries';
import { Icon, PageGlyph } from './Icon';
import { useToast } from './Toast';

type Drop = { id: string; where: 'before' | 'after' | 'inside' } | null;

export function Tree({
  pages,
  currentId,
  onNavigate,
}: {
  pages: PageSummary[];
  currentId: string | undefined;
  onNavigate?: () => void;
}) {
  const roots = useMemo(() => buildTree(pages), [pages]);
  const byId = useMemo(() => new Map(pages.map((p) => [p.id, p])), [pages]);
  const [open, setOpen] = useState<Set<string>>(
    () => new Set(readLocal<string[]>('n2.tree.open', [])),
  );
  const [drag, setDrag] = useState<string | null>(null);
  const [drop, setDrop] = useState<Drop>(null);
  const [renaming, setRenaming] = useState<string | null>(null);
  const [menu, setMenu] = useState<string | null>(null);
  const navigate = useNavigate();
  const toast = useToast();
  const create = useCreatePage();
  const move = useMovePage();
  const rename = useRenamePage();
  const del = useDeletePage();

  // Keep the current page visible: when it changes, expand its ancestors (during render, so the
  // tree never paints collapsed first).
  const [shownFor, setShownFor] = useState<string | undefined>(undefined);
  if (currentId && currentId !== shownFor && byId.has(currentId)) {
    setShownFor(currentId);
    const anc = ancestorsOf(currentId, byId);
    if (anc.some((a) => !open.has(a.id))) setOpen(new Set([...open, ...anc.map((a) => a.id)]));
  }
  useEffect(() => writeLocal('n2.tree.open', [...open]), [open]);

  const toggle = (id: string) =>
    setOpen((o) => {
      const n = new Set(o);
      if (n.has(id)) n.delete(id);
      else n.add(id);
      return n;
    });

  async function addChild(parentId: string | null) {
    try {
      const page = await create.mutateAsync({ title: 'Untitled', parent_id: parentId });
      if (parentId) setOpen((o) => new Set([...o, parentId]));
      navigate(`${pageHref(page.id, page.title)}?edit=1`);
      onNavigate?.();
    } catch (e) {
      toast(errorMessage(e));
    }
  }

  async function remove(p: PageSummary) {
    const count = (id: string): number =>
      pages.filter((c) => c.parent_id === id).reduce((n, c) => n + 1 + count(c.id), 0);
    const n = count(p.id);
    const msg = n
      ? `Delete “${p.title}” and the ${n} page${n === 1 ? '' : 's'} inside it? This can’t be undone.`
      : `Delete “${p.title}”? This can’t be undone.`;
    if (!window.confirm(msg)) return;
    try {
      await del.mutateAsync(p.id);
      if (
        currentId &&
        (currentId === p.id || ancestorsOf(currentId, byId).some((a) => a.id === p.id))
      )
        navigate(p.parent_id ? pageHref(p.parent_id, byId.get(p.parent_id)?.title) : '/');
    } catch (e) {
      toast(errorMessage(e));
    }
  }

  function onDragOver(e: DragEvent, node: TreeNode) {
    if (!drag || drag === node.page.id) return;
    // Can't drop a page into its own subtree.
    if (ancestorsOf(node.page.id, byId).some((a) => a.id === drag)) return;
    e.preventDefault();
    const r = (e.currentTarget as HTMLElement).getBoundingClientRect();
    const y = (e.clientY - r.top) / r.height;
    const where = y < 0.28 ? 'before' : y > 0.72 ? 'after' : 'inside';
    if (drop?.id !== node.page.id || drop.where !== where) setDrop({ id: node.page.id, where });
  }

  async function onDrop(e: DragEvent) {
    e.preventDefault();
    const target = drop && byId.get(drop.id);
    const dragged = drag;
    setDrag(null);
    setDrop(null);
    if (!target || !dragged || !drop) return;
    let parent_id: string | null;
    let position: number | undefined;
    if (drop.where === 'inside') {
      parent_id = target.id;
      setOpen((o) => new Set([...o, target.id]));
    } else {
      parent_id = target.parent_id;
      const siblings = pages
        .filter((p) => p.parent_id === parent_id && p.id !== dragged)
        .sort((a, b) => a.position - b.position || a.title.localeCompare(b.title));
      const i = siblings.findIndex((s) => s.id === target.id);
      position = drop.where === 'before' ? i : i + 1;
    }
    try {
      await move.mutateAsync({ id: dragged, parent_id, position });
    } catch (err) {
      toast(errorMessage(err));
    }
  }

  const render = (nodes: TreeNode[], depth: number) =>
    nodes.map((node) => {
      const p = node.page;
      const isOpen = open.has(p.id);
      const hasKids = node.children.length > 0;
      const dropCls = drop?.id === p.id ? ` drop-${drop.where}` : '';
      return (
        <li
          key={p.id}
          role="treeitem"
          aria-expanded={hasKids ? isOpen : undefined}
          aria-selected={p.id === currentId}
        >
          <div
            className={`tree-row${p.id === currentId ? ' current' : ''}${drag === p.id ? ' dragging' : ''}${dropCls}`}
            style={{ paddingLeft: 6 + depth * 14 }}
            draggable={renaming !== p.id}
            onDragStart={(e) => {
              e.dataTransfer.effectAllowed = 'move';
              e.dataTransfer.setData('text/plain', p.title);
              setDrag(p.id);
            }}
            onDragEnd={() => {
              setDrag(null);
              setDrop(null);
            }}
            onDragOver={(e) => onDragOver(e, node)}
            onDragLeave={() => drop?.id === p.id && setDrop(null)}
            onDrop={onDrop}
          >
            <button
              className={`twisty${hasKids ? '' : ' leaf'}${isOpen ? ' open' : ''}`}
              onClick={() => hasKids && toggle(p.id)}
              aria-label={isOpen ? 'Collapse' : 'Expand'}
              tabIndex={hasKids ? 0 : -1}
            >
              <Icon name="chevron" size={12} />
            </button>
            {renaming === p.id ? (
              <RenameField
                initial={p.title}
                onDone={async (title) => {
                  setRenaming(null);
                  if (title && title !== p.title)
                    await rename
                      .mutateAsync({ id: p.id, title })
                      .catch((e) => toast(errorMessage(e)));
                }}
              />
            ) : (
              <NavLink
                to={pageHref(p.id, p.title)}
                className="tree-link"
                onClick={onNavigate}
                onDoubleClick={() => setRenaming(p.id)}
              >
                <PageGlyph icon={p.icon} folder={hasKids} />
                <span className="tree-title">{p.title}</span>
              </NavLink>
            )}
            <span className="row-actions">
              <button
                onClick={() => addChild(p.id)}
                aria-label={`Add a page inside ${p.title}`}
                title="Add subpage"
              >
                <Icon name="plus" size={14} />
              </button>
              <button
                onClick={() => setMenu(menu === p.id ? null : p.id)}
                aria-label={`More for ${p.title}`}
                aria-haspopup="menu"
                aria-expanded={menu === p.id}
              >
                <Icon name="more" size={14} />
              </button>
            </span>
            {menu === p.id && (
              <Menu onClose={() => setMenu(null)}>
                <button role="menuitem" onClick={() => (setMenu(null), setRenaming(p.id))}>
                  Rename
                </button>
                <button role="menuitem" onClick={() => (setMenu(null), void addChild(p.id))}>
                  Add subpage
                </button>
                {p.parent_id && (
                  <button
                    role="menuitem"
                    onClick={() => {
                      setMenu(null);
                      move.mutate({ id: p.id, parent_id: null });
                    }}
                  >
                    Move to top level
                  </button>
                )}
                <button
                  role="menuitem"
                  className="danger"
                  onClick={() => (setMenu(null), void remove(p))}
                >
                  Delete
                </button>
              </Menu>
            )}
          </div>
          {hasKids && isOpen && (
            <ul role="group" className="tree-group">
              {render(node.children, depth + 1)}
            </ul>
          )}
        </li>
      );
    });

  return (
    <nav className="tree" aria-label="Pages">
      <div className="tree-head">
        <span>Pages</span>
        <button onClick={() => addChild(null)} aria-label="New top-level page" title="New page">
          <Icon name="plus" size={14} />
        </button>
      </div>
      {roots.length ? (
        <ul role="tree" className="tree-root">
          {render(roots, 0)}
        </ul>
      ) : (
        <p className="tree-empty">No pages yet.</p>
      )}
    </nav>
  );
}

function RenameField({ initial, onDone }: { initial: string; onDone(title: string): void }) {
  const [v, setV] = useState(initial);
  const done = useRef(false);
  const finish = (val: string) => {
    if (done.current) return;
    done.current = true;
    onDone(val.trim());
  };
  return (
    <input
      className="tree-rename"
      value={v}
      autoFocus
      onFocus={(e) => e.target.select()}
      onChange={(e) => setV(e.target.value)}
      onBlur={() => finish(v)}
      onKeyDown={(e) => {
        if (e.key === 'Enter') finish(v);
        if (e.key === 'Escape') finish(initial);
      }}
      aria-label="Page title"
    />
  );
}

export function Menu({ children, onClose }: { children: React.ReactNode; onClose(): void }) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const away = (e: MouseEvent) => !ref.current?.contains(e.target as Node) && onClose();
    const esc = (e: KeyboardEvent) => e.key === 'Escape' && onClose();
    document.addEventListener('mousedown', away);
    document.addEventListener('keydown', esc);
    ref.current?.querySelector('button')?.focus();
    return () => {
      document.removeEventListener('mousedown', away);
      document.removeEventListener('keydown', esc);
    };
  }, [onClose]);
  return (
    <div ref={ref} className="menu" role="menu">
      {children}
    </div>
  );
}
