import { useEffect, useMemo, useState } from 'react';
import { Link, NavLink, Outlet, useLocation, useMatch } from 'react-router';
import { AboutButton, AboutSheet } from '../components/AboutSheet';
import { useTree } from '../lib/queries';
import { Icon } from '../components/Icon';
import { Palette } from '../components/Palette';
import { Tree } from '../components/Tree';

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
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') {
        e.preventDefault();
        setPalette((p) => !p);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  return (
    <div className={`shell${nav ? ' nav-open' : ''}`}>
      <aside className="sidebar">
        <div className="brand">
          <Link to="/" className="brand-link">
            <img src="/favicon.svg" alt="" width={22} height={22} />
            <span>Nitrogen</span>
          </Link>
        </div>
        <button className="search-button" onClick={() => setPalette(true)}>
          <Icon name="search" size={15} />
          <span>Search</span>
          <kbd>⌘K</kbd>
        </button>
        <nav className="side-nav" aria-label="Wiki">
          {(
            [
              ['/dashboard', 'home', 'Dashboard'],
              ['/activity', 'activity', 'Activity'],
              ['/insights', 'insights', 'Insights'],
              ['/tags', 'tag', 'Tags'],
            ] as const
          ).map(([to, icon, label]) => (
            <NavLink key={to} to={to} end className="foot-link">
              <Icon name={icon} size={15} /> {label}
            </NavLink>
          ))}
        </nav>
        {tree.data ? (
          <Tree pages={pages} currentId={match?.params.id} onNavigate={() => setNav(false)} />
        ) : (
          <p className="tree-empty">{tree.isError ? 'Could not load pages.' : 'Loading…'}</p>
        )}
        {sessionCount > 0 && (
          <NavLink to="/sessions" className="foot-link sessions-link">
            <Icon name="sparkle" size={15} /> AI Sessions
          </NavLink>
        )}
        <div className="sidebar-foot">
          <NavLink to="/settings" className="foot-link">
            <Icon name="settings" size={15} /> Settings
          </NavLink>
          <AboutButton className="foot-link about-side" onClick={() => setAbout(true)} />
        </div>
      </aside>
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
          <span className="mobile-title">Nitrogen</span>
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
