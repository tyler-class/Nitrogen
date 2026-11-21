import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { readLocal, writeLocal } from '../lib/storage';
import { Link, NavLink, Outlet, useLocation, useMatch, useNavigationType } from 'react-router';
import { useTree } from '../lib/queries';
import { useNotifications } from '../lib/notifications';
import { Icon } from '../components/Icon';
import { Palette } from '../components/Palette';
import { Bell } from '../components/Bell';
import { Tree } from '../components/Tree';

const MIN_W = 200;
const MAX_W = 460;

/** The everyday views, as one pill: icons only, the current one with its name. */
const VIEWS = [
  ['/', 'home', 'Home'],
  ['/items', 'checks', 'Action Items'],
  ['/activity', 'activity', 'Activity'],
] as const;

/** Places visited now and then, as round icon buttons along the bottom of the sidebar. */
const SHELF = [
  ['/tags', 'tag', 'Tags'],
  ['/insights', 'insights', 'Insights'],
  ['/sessions', 'sparkle', 'AI Sessions'],
  ['/archive', 'archive', 'Archive'],
  ['/settings', 'settings', 'Settings'],
] as const;

/**
 * Phones: the menu follows the finger. Drag right from the left edge and the page slides aside
 * with it (the sidebar drifting in underneath); let go past about 30% of the way and it opens,
 * short of that and it slides back. With it open, drag left anywhere to close it the same way.
 * A quick flick counts too. That's the only sideways swipe: a swipe from the edge is ours, not
 * the browser's back gesture. While dragging, it sets --nav-p (how open, 0 to 1) on the shell.
 */
function useDrawerSwipe(
  shell: React.RefObject<HTMLDivElement | null>,
  open: boolean,
  setOpen: (v: boolean) => void,
  setDragging: (v: boolean) => void,
) {
  useEffect(() => {
    const phone = window.matchMedia('(max-width: 860px)');
    let start: { x: number; y: number } | null = null;
    // 'side' once it's clearly a sideways drag, 'no' once it's clearly a scroll.
    let axis: 'side' | 'no' | null = null;
    let width = 1;
    let p = open ? 1 : 0;
    let last = { x: 0, t: 0, v: 0 };
    const set = (v: number) => shell.current?.style.setProperty('--nav-p', String(v));
    const down = (e: TouchEvent) => {
      const t = e.touches[0];
      start = null;
      axis = null;
      if (!phone.matches || !t || e.touches.length > 1) return;
      // Opening only from the edge, so scrolling sideways in a page (tables, code) still works.
      if (!open && t.clientX > 28) return;
      start = { x: t.clientX, y: t.clientY };
      last = { x: t.clientX, t: e.timeStamp, v: 0 };
      width = shell.current?.querySelector<HTMLElement>('.sidebar')?.offsetWidth || 1;
    };
    const move = (e: TouchEvent) => {
      const t = e.touches[0];
      if (!start || !t || axis === 'no') return;
      const dx = t.clientX - start.x;
      const dy = t.clientY - start.y;
      if (!axis) {
        if (Math.abs(dx) < 8 && Math.abs(dy) < 8) return;
        // Sideways and the right way (right to open, left to close), or it's a scroll.
        axis = Math.abs(dx) > Math.abs(dy) && (open ? dx < 0 : dx > 0) ? 'side' : 'no';
        if (axis === 'no') return;
        setDragging(true);
      }
      if (e.cancelable) e.preventDefault();
      p = Math.min(1, Math.max(0, (open ? 1 : 0) + dx / width));
      set(p);
      const dt = e.timeStamp - last.t;
      if (dt > 0) last = { x: t.clientX, t: e.timeStamp, v: (t.clientX - last.x) / dt };
    };
    const up = () => {
      if (axis !== 'side') {
        start = null;
        return;
      }
      start = null;
      axis = null;
      // Past 30% of the way (either way), or a quick flick that way.
      const flick = Math.abs(last.v) > 0.5;
      const next = open ? !(p < 0.7 || (flick && last.v < 0)) : p > 0.3 || (flick && last.v > 0);
      shell.current?.style.removeProperty('--nav-p');
      setDragging(false);
      setOpen(next);
    };
    document.addEventListener('touchstart', down, { passive: true });
    document.addEventListener('touchmove', move, { passive: false });
    document.addEventListener('touchend', up, { passive: true });
    document.addEventListener('touchcancel', up, { passive: true });
    return () => {
      document.removeEventListener('touchstart', down);
      document.removeEventListener('touchmove', move);
      document.removeEventListener('touchend', up);
      document.removeEventListener('touchcancel', up);
    };
  }, [shell, open, setOpen, setDragging]);
}

export function Layout() {
  const tree = useTree();
  // Notification taps open in-app; the app-icon badge follows what's due.
  useNotifications();
  // Rows that pin while scrolling (the editor's header and toolbar) sit just under the phone header.
  const bar = useRef<HTMLElement>(null);
  useEffect(() => {
    const el = bar.current;
    if (!el || typeof ResizeObserver === 'undefined') return;
    // Rounded down, so what pins under it overlaps it by a fraction instead of leaving a
    // hairline gap that scrolling text shows through (offsetHeight rounds either way).
    const set = () =>
      document.documentElement.style.setProperty(
        '--mobile-bar-h',
        `${Math.floor(el.getBoundingClientRect().height)}px`,
      );
    const ro = new ResizeObserver(set);
    ro.observe(el);
    set();
    return () => ro.disconnect();
  }, []);
  // The splat also matches /p/:id without a slug.
  const match = useMatch('/p/:id/*');
  const [nav, setNav] = useState(false);
  const [palette, setPalette] = useState(false);
  // Sessions and AI Instructions live outside the page tree (AI Instructions inside AI Sessions).
  const sessionsId = tree.data?.sessions_id ?? null;
  const instructionsId = tree.data?.instructions_id ?? null;
  // AI Instructions sits inside AI Sessions, so AI Sessions stays lit there.
  const instructionsOpen = !!useMatch('/instructions');
  const pages = useMemo(
    () =>
      (tree.data?.pages ?? []).filter(
        (p) =>
          p.id !== instructionsId &&
          (!sessionsId || (p.id !== sessionsId && p.parent_id !== sessionsId)),
      ),
    [tree.data, sessionsId, instructionsId],
  );
  const location = useLocation();
  const navType = useNavigationType();
  const mainRef = useRef<HTMLDivElement>(null);
  // "/p/<id>" for a page (its slug can change), else the path.
  const pageKey = location.pathname.split('/').slice(0, 3).join('/');
  // A new page opens at its top (phones scroll the window, wider screens the main column). Back
  // and forward keep where you were; a link to a heading scrolls there itself.
  useLayoutEffect(() => {
    if (navType === 'POP' || location.hash) return;
    window.scrollTo(0, 0);
    if (mainRef.current) mainRef.current.scrollTop = 0;
    // Only a change of page counts, not ?edit=1 or the slug catching up.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pageKey]);

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
  // While the sidebar slides, the page's text keeps the width it has with the sidebar open, so
  // lines never rewrap partway through the slide (that was a sudden jump in the middle).
  const [sliding, setSliding] = useState(false);
  const slideTimer = useRef<number | undefined>(undefined);
  // While the sidebar slides, the page takes its final width at once (so text never rewraps
  // partway), which would throw anything on its right edge (the Saved / History / More row) across
  // in one frame. And hiding it, the page's content would ride the column's edge, covering its
  // whole distance in the column's 0.42s and running ahead of the sidebar (which only drifts half
  // as far). So each frame they're nudged (a transform) from where the layout has them to where a
  // smooth glide says they should be: closing, the page glides on its own slightly slower curve;
  // both ways, the right-hand buttons glide from where they were to where they end up.
  const slideFrom = useRef<{ left: number; right: number | null; width: number } | null>(null);
  useLayoutEffect(() => {
    const from = slideFrom.current;
    slideFrom.current = null;
    const main = mainRef.current;
    const el = main?.firstElementChild as HTMLElement | null;
    if (!from || !main || !el) return;
    const acts = el.querySelector<HTMLElement>('.page-actions');
    // Where the page ends up once the column has finished: centred in the main column (or with
    // the pinned outline's room on its right), its width already final (held during the slide).
    const total = main.clientWidth + main.getBoundingClientRect().left;
    const base = collapsed ? 20 : width;
    const room = total - base;
    const w = el.getBoundingClientRect().width;
    const right = el.classList.contains('outline-pinned')
      ? Math.max(256, (room - 880) / 2)
      : Math.max(0, (room - w) / 2);
    const to = base + Math.max(0, room - w - right);
    // The buttons sit a fixed distance in from the page's right edge.
    const inset = acts ? el.getBoundingClientRect().right - acts.getBoundingClientRect().right : 0;
    const actsTo = to + w - inset;
    // Closing: a little slower than the column (0.42s), so it trails the sidebar.
    const TIME = collapsed ? 520 : 420;
    const t0 = performance.now();
    const ease = (t: number) => 1 - Math.pow(1 - t, 3);
    let frame = 0;
    const step = (now: number) => {
      const t = Math.min(1, (now - t0) / TIME);
      const k = 1 - ease(t);
      if (collapsed) {
        el.style.transform = '';
        const at = el.getBoundingClientRect().left;
        el.style.transform = t < 1 ? `translateX(${to + (from.left - to) * k - at}px)` : '';
      }
      // Only when the page's width changes: otherwise they ride with the page as it is.
      if (acts && from.right != null && Math.abs(w - from.width) > 1) {
        acts.style.transform = '';
        const at = acts.getBoundingClientRect().right;
        acts.style.transform =
          t < 1 ? `translateX(${actsTo + (from.right - actsTo) * k - at}px)` : '';
      }
      if (t < 1) frame = requestAnimationFrame(step);
    };
    step(t0);
    return () => {
      cancelAnimationFrame(frame);
      el.style.transform = '';
      if (acts) acts.style.transform = '';
    };
    // `width` is read for where the page ends up; only a toggle starts a glide.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [collapsed]);

  const collapsedNow = useRef(collapsed);
  useEffect(() => {
    collapsedNow.current = collapsed;
  }, [collapsed]);
  const toggleCollapsed = () => {
    const main = mainRef.current;
    const el = main?.firstElementChild;
    // The width the page will have once the slide is over, held from the start (see side-sliding
    // in the CSS): the main column's own width, so a visible scrollbar is allowed for (the
    // window's width would count it and leave the page too wide until the end, then snap back).
    if (main && el) {
      const total = main.clientWidth + main.getBoundingClientRect().left;
      const room = collapsedNow.current ? total - width : total - 20;
      // The page's own width at the end: its max width, less the pinned outline's room on the
      // right when that's showing.
      const max = parseFloat(getComputedStyle(el).maxWidth) || Infinity;
      const side = el.classList.contains('outline-pinned') ? Math.max(256, (room - 880) / 2) : 0;
      const w = Math.max(0, Math.min(max, room - side));
      shellRef.current?.style.setProperty('--slide-w', `${w}px`);
    }
    const calm = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    slideFrom.current =
      el && !calm && window.matchMedia('(min-width: 861px)').matches
        ? {
            left: el.getBoundingClientRect().left,
            right: el.querySelector('.page-actions')?.getBoundingClientRect().right ?? null,
            width: el.getBoundingClientRect().width,
          }
        : null;
    setSliding(true);
    window.clearTimeout(slideTimer.current);
    slideTimer.current = window.setTimeout(() => setSliding(false), 460);
    setCollapsed((c) => {
      writeLocal('n2.sidebar.collapsed', !c);
      return !c;
    });
  };
  // The shortcut's handler is set up once: it calls the latest toggle (current width and all).
  const toggleRef = useRef(toggleCollapsed);
  useEffect(() => {
    toggleRef.current = toggleCollapsed;
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
  // The menu is "in play" while it's open, being dragged, or sliding shut: only then does the
  // page move aside (so nothing fixed inside the page is thrown off the rest of the time).
  const shellRef = useRef<HTMLDivElement>(null);
  const [dragging, setDragging] = useState(false);
  const [settling, setSettling] = useState(false);
  // Closing, or letting go of a drag that falls short: stay in play while it slides back.
  const inPlay = nav || dragging;
  const wasInPlay = useRef(inPlay);
  useEffect(() => {
    const was = wasInPlay.current;
    wasInPlay.current = inPlay;
    if (!was || inPlay) return;
    setSettling(true);
    const t = window.setTimeout(() => setSettling(false), 380);
    return () => window.clearTimeout(t);
  }, [inPlay]);
  useDrawerSwipe(shellRef, nav, setNav, setDragging);
  // Phones: while the menu is in play the page behind it doesn't scroll. Released only once the
  // slide has finished: letting go mid-slide made Safari re-lay the page out and stall the close.
  const locked = nav || dragging || settling;
  useEffect(() => {
    document.documentElement.classList.toggle('nav-locked', locked);
  }, [locked]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') {
        e.preventDefault();
        setPalette((p) => !p);
      }
      if ((e.metaKey || e.ctrlKey) && e.key === '\\') {
        e.preventDefault();
        toggleRef.current();
      }
      if (e.key === 'Escape') setNav(false);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  return (
    <div
      ref={shellRef}
      className={`shell${nav ? ' nav-open' : ''}${nav || dragging || settling ? ' nav-on' : ''}${
        dragging ? ' dragging' : ''
      }${collapsed ? ' collapsed' : ''}${sliding ? ' side-sliding' : ''}`}
      style={{ '--sidebar-w': `${width}px` } as React.CSSProperties}
    >
      <aside className="sidebar" aria-label="Navigation">
        <div className="brand">
          <Link to="/" className="brand-link">
            <img src="/favicon.svg" alt="" width={22} height={22} />
            <span>Nitrogen</span>
          </Link>
          <Bell className="desktop-only" size={20} />
          <button
            className="side-toggle desktop-only"
            onClick={toggleCollapsed}
            aria-label="Hide sidebar"
            title={'Hide sidebar (⌘\\)'}
          >
            <Icon name="panelLeft" size={20} />
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
            <NavLink key={to} to={to} end className="vp-item" aria-label={label} title={label}>
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
        {/* The shelf: the places outside the tree. AI Sessions stays lit inside AI Instructions. */}
        <nav className="sidebar-foot shelf" aria-label="More">
          {SHELF.map(([to, icon, label]) => (
            <NavLink
              key={to}
              to={to}
              end={to === '/settings'}
              className={({ isActive }) =>
                `shelf-btn${isActive || (to === '/sessions' && instructionsOpen) ? ' active' : ''}`
              }
              aria-label={label}
              title={label}
            >
              <Icon name={icon} size={18} />
            </NavLink>
          ))}
        </nav>
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
          <Icon name="panelLeft" size={20} />
        </button>
      )}
      <button
        className="nav-scrim"
        aria-label="Close menu"
        onClick={() => setNav(false)}
        tabIndex={-1}
      />
      {/* Phones: the header is pinned to the top of the screen, outside the scrolling page. */}
      <header className="mobile-bar" ref={bar}>
        <button onClick={() => setNav(true)} aria-label="Open menu" className="menu-btn">
          <Icon name="menu" size={24} />
        </button>
        <Link to="/" className="mobile-title">
          <img src="/favicon.svg" alt="" width={22} height={22} />
          Nitrogen
        </Link>
        <span className="mobile-bar-end">
          <Bell className="menu-btn" size={24} />
          <button
            onClick={() => setPalette(true)}
            aria-label="Search"
            className="menu-btn search-btn"
          >
            <Icon name="search" size={24} />
          </button>
        </span>
      </header>
      <div className="main" ref={mainRef}>
        <Outlet />
      </div>
      {palette && tree.data && <Palette pages={pages} onClose={() => setPalette(false)} />}
    </div>
  );
}
