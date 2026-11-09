import { useEffect, useMemo, useRef, useState } from 'react';
import { readLocal, writeLocal } from '../lib/storage';
import { Link, NavLink, Outlet, useLocation, useMatch } from 'react-router';
import { AboutButton, AboutSheet } from '../components/AboutSheet';
import { useTree } from '../lib/queries';
import { Icon } from '../components/Icon';
import { Palette } from '../components/Palette';
import { Tree } from '../components/Tree';

const MIN_W = 200;
const MAX_W = 460;

/** The four views, as one pill: icons only, the current one with its name. */
const VIEWS = [
  ['/', 'home', 'Home'],
  ['/activity', 'activity', 'Activity'],
  ['/insights', 'insights', 'Insights'],
  ['/tags', 'tag', 'Tags'],
] as const;

/** Phones: swipe left to close the open menu, swipe right from the left edge to open it. */
function useEdgeSwipe(open: boolean, setOpen: (v: boolean) => void) {
  const start = useRef<{ x: number; y: number; t: number } | null>(null);
  useEffect(() => {
    const phone = window.matchMedia('(max-width: 860px)');
    const down = (e: TouchEvent) => {
      const t = e.touches[0];
      start.current = null;
      if (!phone.matches || !t || e.touches.length > 1) return;
      // Opening only from the edge, so scrolling sideways in a page (tables, code) still works.
      if (!open && t.clientX > 28) return;
      start.current = { x: t.clientX, y: t.clientY, t: Date.now() };
    };
    const up = (e: TouchEvent) => {
      const s = start.current;
      const t = e.changedTouches[0];
      start.current = null;
      if (!s || !t) return;
      const dx = t.clientX - s.x;
      const dy = t.clientY - s.y;
      // A quick, mostly sideways swipe.
      if (Math.abs(dx) < 50 || Math.abs(dy) > Math.abs(dx) * 0.7 || Date.now() - s.t > 600) return;
      if (open && dx < 0) setOpen(false);
      if (!open && dx > 0) setOpen(true);
    };
    document.addEventListener('touchstart', down, { passive: true });
    document.addEventListener('touchend', up, { passive: true });
    return () => {
      document.removeEventListener('touchstart', down);
      document.removeEventListener('touchend', up);
    };
  }, [open, setOpen]);
}

export function Layout() {
  const tree = useTree();
  // The splat also matches /p/:id without a slug.
  const match = useMatch('/p/:id/*');
  const [nav, setNav] = useState(false);
  const [palette, setPalette] = useState(false);
  const [about, setAbout] = useState(false);
  // Sessions live outside the page tree, behind their own button.
  const sessionsId = tree.data?.sessions_id ?? null;
  const pages = useMemo(
    () =>
      (tree.data?.pages ?? []).filter(
        (p) => !sessionsId || (p.id !== sessionsId && p.parent_id !== sessionsId),
      ),
    [tree.data, sessionsId],
  );
  const sessionCount = (tree.data?.pages.length ?? 0) - pages.length - (sessionsId ? 1 : 0);
  const location = useLocation();

  // Close the mobile menu after navigating.
  const [navPath, setNavPath] = useState(location.pathname);
  if (navPath !== location.pathname) {
    setNavPath(location.pathname);
    setNav(false);
  }
  // Desktop: a resizable, collapsible sidebar, remembered on this device.
  const [width, setWidth] = useState(() =>
    Math.min(MAX_W, Math.max(MIN_W, Number(readLocal('n2.sidebar.w', 272)) || 272)),
  );
  const [collapsed, setCollapsed] = useState(() => readLocal('n2.sidebar.collapsed', false));
  const toggleCollapsed = () =>
    setCollapsed((c) => {
      writeLocal('n2.sidebar.collapsed', !c);
      return !c;
    });
  const startResize = (e: React.PointerEvent) => {
    e.preventDefault();
    const startX = e.clientX;
    const startW = width;
    let w = startW;
    const move = (ev: PointerEvent) => {
      w = Math.min(MAX_W, Math.max(MIN_W, startW + ev.clientX - startX));
      setWidth(w);
    };
    const up = () => {
      writeLocal('n2.sidebar.w', w);
      document.body.classList.remove('resizing');
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
    };
    document.body.classList.add('resizing');
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
  };
  useEdgeSwipe(nav, setNav);
  // Phones: the menu covers the page, so the page behind it shouldn't scroll.
  useEffect(() => {
    document.body.classList.toggle('nav-locked', nav);
  }, [nav]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') {
        e.preventDefault();
        setPalette((p) => !p);
      }
      if ((e.metaKey || e.ctrlKey) && e.key === '\\') {
        e.preventDefault();
        toggleCollapsed();
      }
      if (e.key === 'Escape') setNav(false);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  return (
    <div
      className={`shell${nav ? ' nav-open' : ''}${collapsed ? ' collapsed' : ''}`}
      style={{ '--sidebar-w': `${width}px` } as React.CSSProperties}
    >
      <aside className="sidebar" aria-label="Navigation">
        <div className="brand">
          <Link to="/" className="brand-link">
            <img src="/favicon.svg" alt="" width={22} height={22} />
            <span>Nitrogen</span>
          </Link>
          <button
            className="side-toggle desktop-only"
            onClick={toggleCollapsed}
            aria-label="Hide sidebar"
            title={'Hide sidebar (⌘\\)'}
          >
            <Icon name="panelLeft" size={17} />
          </button>
          <button
            className="side-close mobile-only"
            onClick={() => setNav(false)}
            aria-label="Close menu"
          >
            <Icon name="close" size={20} />
          </button>
        </div>
        <button className="search-button" onClick={() => setPalette(true)}>
          <Icon name="search" size={15} />
          <span>Search</span>
          <kbd>⌘K</kbd>
        </button>
        <nav className="view-pill" aria-label="Views">
          {VIEWS.map(([to, icon, label]) => (
            <NavLink
              key={to}
              to={to}
              end={to !== '/tags'}
              className="vp-item"
              aria-label={label}
              title={label}
            >
              <Icon name={icon} size={16} />
              <span className="vp-label">{label}</span>
            </NavLink>
          ))}
        </nav>
        <hr className="side-rule" />
        {tree.data ? (
          <Tree pages={pages} currentId={match?.params.id} onNavigate={() => setNav(false)} />
        ) : (
          <p className="tree-empty">{tree.isError ? 'Could not load pages.' : 'Loading…'}</p>
        )}
        {/* One rule above the footer links (AI sessions, when there are any, then Settings). */}
        <div className="sidebar-foot">
          {sessionCount > 0 && (
            <NavLink to="/sessions" className="foot-link sessions-link">
              <Icon name="sparkle" size={15} /> AI Sessions
            </NavLink>
          )}
          <NavLink to="/settings" className="foot-link">
            <Icon name="settings" size={15} /> Settings
          </NavLink>
          <AboutButton className="foot-link about-side" onClick={() => setAbout(true)} />
        </div>
        <div
          className="side-resize"
          role="separator"
          aria-orientation="vertical"
          aria-label="Resize sidebar"
          onPointerDown={startResize}
          onDoubleClick={() => {
            setWidth(272);
            writeLocal('n2.sidebar.w', 272);
          }}
        />
      </aside>
      {collapsed && (
        <button
          className="side-open desktop-only"
          onClick={toggleCollapsed}
          aria-label="Show sidebar"
          title={'Show sidebar (⌘\\)'}
        >
          <Icon name="panelLeft" size={17} />
        </button>
      )}
      <button
        className="nav-scrim"
        aria-label="Close menu"
        onClick={() => setNav(false)}
        tabIndex={-1}
      />
      <div className="main">
        <header className="mobile-bar">
          <button onClick={() => setNav(true)} aria-label="Open menu">
            <Icon name="menu" />
          </button>
          <Link to="/" className="mobile-title">
            <img src="/favicon.svg" alt="" width={22} height={22} />
            Nitrogen
          </Link>
          <button onClick={() => setPalette(true)} aria-label="Search">
            <Icon name="search" />
          </button>
        </header>
        <Outlet />
      </div>
      {about && <AboutSheet onClose={() => setAbout(false)} />}
      {palette && tree.data && <Palette pages={pages} onClose={() => setPalette(false)} />}
    </div>
  );
}
