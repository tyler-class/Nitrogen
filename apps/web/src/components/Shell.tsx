import { useEffect, useMemo, useState, type ReactNode } from 'react';
import { Link, Outlet, useNavigate, useRouterState } from '@tanstack/react-router';
import { useChangesPoll, useMe, useTree } from '../api/hooks.ts';
import { buildTree, type TreeNode } from '../lib/tree.ts';
import { Tree } from './Tree.tsx';
import { Palette } from './Palette.tsx';
import { SyncPill, Toasts } from './SyncPill.tsx';
import { Icon } from './Icon.tsx';
import { ContextMenu } from './ContextMenu.tsx';
import { ApiError } from '../api/client.ts';

export function Logo() {
  return (
    <span className="logo" aria-hidden>
      <span>
        N<sub>2</sub>
      </span>
    </span>
  );
}

export function currentPagePath(pathname: string): string | null {
  if (pathname === '/') return 'index.md';
  const m = /^\/(?:p|edit)\/(.+)$/.exec(pathname);
  return m ? decodeURIComponent(m[1]!) : null;
}

/** Rail content is provided by the page route through this tiny global slot. */
let railSetter: ((n: ReactNode) => void) | null = null;
export function useRail(node: ReactNode, deps: unknown[]) {
  useEffect(() => {
    railSetter?.(node);
    return () => railSetter?.(null);
  }, deps); // eslint-disable-line react-hooks/exhaustive-deps
}

export function Shell() {
  const tree = useTree();
  const me = useMe();
  useChangesPoll();
  const navigate = useNavigate();
  const pathname = useRouterState({ select: (s) => s.location.pathname });
  const active = currentPagePath(pathname);
  const [paletteOpen, setPaletteOpen] = useState(false);
  const [sideOpen, setSideOpen] = useState(false);
  const [rail, setRail] = useState<ReactNode>(null);
  const [menu, setMenu] = useState<{ node: TreeNode; x: number; y: number } | null>(null);
  railSetter = setRail;
  const root = useMemo(() => (tree.data ? buildTree(tree.data.pages) : null), [tree.data]);
  const pinned = tree.data?.pages.filter((p) => p.pinned) ?? [];

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') {
        e.preventDefault();
        setPaletteOpen((o) => !o);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);
  useEffect(() => setSideOpen(false), [pathname]);

  const unauthorized = (tree.error instanceof ApiError && tree.error.status === 401) || (me.error instanceof ApiError && me.error.status === 401);
  if (unauthorized) return <SignIn />;

  const title = active ? (tree.data?.pages.find((p) => p.path === active)?.title ?? '') : '';
  return (
    <div className={`shell${rail ? '' : ' no-rail'}`}>
      <a href="#main" className="sr-only">Skip to content</a>
      <nav className="sidebar" data-open={sideOpen} aria-label="Wiki navigation">
        <div className="brand">
          <Logo /> Nitrogen
        </div>
        <button className="search-trigger" onClick={() => setPaletteOpen(true)}>
          <Icon name="search" size={14} /> Search <kbd>⌘K</kbd>
        </button>
        <div className="side-scroll">
          {pinned.length > 0 && (
            <>
              <div className="side-group" id="pinned-label">Pinned</div>
              <ul className="tree" aria-labelledby="pinned-label">
                {pinned.map((p) => (
                  <li key={p.path}>
                    <Link to="/p/$" params={{ _splat: p.path }} className="tree-row" aria-current={p.path === active ? 'page' : undefined}>
                      <span className="twisty" />
                      <span className="glyph">{p.icon && [...p.icon].length <= 2 ? p.icon : '★'}</span>
                      <span className="label">{p.title}</span>
                    </Link>
                  </li>
                ))}
              </ul>
            </>
          )}
          <div className="side-group">Pages</div>
          {root ? (
            root.children.length ? (
              <Tree root={root} active={active} onContext={(node, x, y) => setMenu({ node, x, y })} />
            ) : (
              <p className="empty" style={{ fontSize: 14 }}>No pages yet. <Link to="/new" search={{ dir: '' }}>Create the first one.</Link></p>
            )
          ) : tree.isError ? (
            <p className="empty" style={{ fontSize: 14 }} role="alert">{(tree.error as Error).message}</p>
          ) : (
            [1, 2, 3, 4, 5].map((i) => <div key={i} className="skeleton-line" style={{ width: `${50 + i * 8}%` }} />)
          )}
        </div>
        <div className="side-footer">
          <Link to="/activity">Activity</Link>
          <Link to="/links" search={active ? { page: active } : {}}>Link explorer</Link>
          <Link to="/settings">Settings</Link>
          <SyncPill />
        </div>
      </nav>
      {sideOpen && <div className="scrim" style={{ zIndex: 44 }} onClick={() => setSideOpen(false)} />}
      <div className="main" id="main" tabIndex={-1}>
        <header className="topbar">
          <button className="icon-btn" aria-label="Open navigation" onClick={() => setSideOpen(true)}><Icon name="menu" size={20} /></button>
          <span className="title">{title || 'Nitrogen'}</span>
          <button className="icon-btn" aria-label="Search" onClick={() => setPaletteOpen(true)}><Icon name="search" size={20} /></button>
          {active && (
            <button className="icon-btn" aria-label="Edit page" onClick={() => void navigate({ to: '/edit/$', params: { _splat: active } })}><Icon name="edit" size={20} /></button>
          )}
        </header>
        <Outlet />
      </div>
      {rail && <aside className="rail" aria-label="Page context">{rail}</aside>}
      {paletteOpen && <Palette onClose={() => setPaletteOpen(false)} currentPath={active} />}
      {menu && <ContextMenu {...menu} onClose={() => setMenu(null)} />}
      <Toasts />
    </div>
  );
}

export function SignIn() {
  const ret = `${location.pathname}${location.search}`;
  return (
    <main style={{ maxWidth: 420, margin: '18vh auto', padding: 24, textAlign: 'center' }}>
      <div style={{ display: 'flex', justifyContent: 'center', alignItems: 'center', gap: 10, fontWeight: 600, fontSize: 22 }}>
        <Logo /> Nitrogen
      </div>
      <p style={{ color: 'var(--muted)' }}>Your wiki lives in a GitHub repo. Sign in with the GitHub account allowed on this wiki.</p>
      <a className="btn btn-primary" href={`/auth/login?return=${encodeURIComponent(ret)}`}>Sign in with GitHub</a>
    </main>
  );
}
