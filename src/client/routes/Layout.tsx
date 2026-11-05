import { useEffect, useState } from 'react';
import { Link, Outlet, useLocation, useMatch } from 'react-router';
import { useQuery } from '@tanstack/react-query';
import { api } from '../lib/api';
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
  const location = useLocation();
  const session = useQuery({
    queryKey: ['session'],
    queryFn: () => api.get<{ instance_name: string }>('/session'),
    staleTime: Infinity,
  });

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

  const name = session.data?.instance_name ?? 'Nitrogen';
  useEffect(() => {
    document.title = name;
  }, [name]);

  return (
    <div className={`shell${nav ? ' nav-open' : ''}`}>
      <aside className="sidebar">
        <div className="brand">
          <Link to="/" className="brand-link">
            <img src="/favicon.svg" alt="" width={22} height={22} />
            <span>{name}</span>
          </Link>
        </div>
        <button className="search-button" onClick={() => setPalette(true)}>
          <Icon name="search" size={15} />
          <span>Search</span>
          <kbd>⌘K</kbd>
        </button>
        {tree.data ? (
          <Tree
            pages={tree.data.pages}
            currentId={match?.params.id}
            onNavigate={() => setNav(false)}
          />
        ) : (
          <p className="tree-empty">{tree.isError ? 'Could not load pages.' : 'Loading…'}</p>
        )}
        <div className="sidebar-foot">
          <Link to="/settings" className="foot-link">
            <Icon name="settings" size={15} /> Settings
          </Link>
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
          <span className="mobile-title">{name}</span>
          <button onClick={() => setPalette(true)} aria-label="Search">
            <Icon name="search" />
          </button>
        </header>
        <Outlet />
      </div>
      {palette && tree.data && (
        <Palette pages={tree.data.pages} onClose={() => setPalette(false)} />
      )}
    </div>
  );
}
