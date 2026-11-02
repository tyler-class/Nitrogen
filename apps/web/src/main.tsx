import { StrictMode, lazy, Suspense } from 'react';
import { createRoot } from 'react-dom/client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { createRootRoute, createRoute, createRouter, RouterProvider, useParams, useSearch } from '@tanstack/react-router';
import './styles/tokens.css';
import './styles/app.css';
import { Shell } from './components/Shell.tsx';
import { PageView } from './routes/PageView.tsx';
import { ActivityView, BrokenView, MoveView, NewPageView, SearchView, SettingsView } from './routes/misc.tsx';
import { LinkExplorer, type ExplorerSearch } from './routes/LinkExplorer.tsx';
import { HistoryView, DiffView } from './routes/History.tsx';
import { applyTheme, getTheme } from './lib/theme.ts';
import { installSyncTriggers } from './lib/sync.ts';

const Editor = lazy(() => import('./editor/EditorView.tsx'));
const ExportView = lazy(() => import('./routes/ExportView.tsx'));

applyTheme(getTheme());

const queryClient = new QueryClient({ defaultOptions: { queries: { retry: (n, e) => n < 2 && (e as { status?: number }).status !== 401 && (e as { status?: number }).status !== 404, refetchOnWindowFocus: false } } });

const rootRoute = createRootRoute({ component: Shell });
const str = (v: unknown) => (typeof v === 'string' ? v : undefined);

function PageRoute() {
  const { _splat } = useParams({ strict: false }) as { _splat?: string };
  return <PageView path={_splat ?? 'index.md'} key={_splat} />;
}

const routes = [
  createRoute({ getParentRoute: () => rootRoute, path: '/', component: () => <PageView path="index.md" /> }),
  createRoute({ getParentRoute: () => rootRoute, path: '/p/$', component: PageRoute }),
  createRoute({
    getParentRoute: () => rootRoute,
    path: '/edit/$',
    component: function EditRoute() {
      const { _splat } = useParams({ strict: false }) as { _splat?: string };
      return (
        <Suspense fallback={<div className="page"><div className="skeleton-line" /></div>}>
          <Editor path={_splat ?? 'index.md'} key={_splat} />
        </Suspense>
      );
    },
  }),
  createRoute({ getParentRoute: () => rootRoute, path: '/search', validateSearch: (s: Record<string, unknown>) => ({ q: str(s.q) ?? '' }), component: function S() { const { q } = useSearch({ strict: false }) as { q: string }; return <SearchView q={q} key={q} />; } }),
  createRoute({ getParentRoute: () => rootRoute, path: '/activity', component: ActivityView }),
  createRoute({ getParentRoute: () => rootRoute, path: '/settings', component: SettingsView }),
  createRoute({ getParentRoute: () => rootRoute, path: '/broken', component: BrokenView }),
  createRoute({ getParentRoute: () => rootRoute, path: '/new', validateSearch: (s: Record<string, unknown>): { dir?: string; path?: string; title?: string } => ({ dir: str(s.dir), path: str(s.path), title: str(s.title) }), component: function N() { const s = useSearch({ strict: false }) as { dir?: string; path?: string; title?: string }; return <NewPageView {...s} />; } }),
  createRoute({ getParentRoute: () => rootRoute, path: '/move', validateSearch: (s: Record<string, unknown>) => ({ path: str(s.path) ?? '' }), component: function M() { const s = useSearch({ strict: false }) as { path: string }; return <MoveView path={s.path} />; } }),
  createRoute({ getParentRoute: () => rootRoute, path: '/history', validateSearch: (s: Record<string, unknown>) => ({ path: str(s.path) ?? '' }), component: function H() { const s = useSearch({ strict: false }) as { path: string }; return <HistoryView path={s.path} />; } }),
  createRoute({ getParentRoute: () => rootRoute, path: '/diff', validateSearch: (s: Record<string, unknown>) => ({ sha: str(s.sha) ?? '' }), component: function D() { const s = useSearch({ strict: false }) as { sha: string }; return <DiffView sha={s.sha} />; } }),
  createRoute({
    getParentRoute: () => rootRoute,
    path: '/links',
    validateSearch: (s: Record<string, unknown>): ExplorerSearch => Object.fromEntries(['page', 'lens', 'dir', 'rel', 'rows', 'cols', 'depth', 'under', 'tag', 'status'].map((k) => [k, str(s[k])]).filter(([, v]) => v !== undefined)) as ExplorerSearch,
    component: function L() { const s = useSearch({ strict: false }) as ExplorerSearch; return <LinkExplorer search={s} />; },
  }),
  createRoute({
    getParentRoute: () => rootRoute,
    path: '/export',
    validateSearch: (s: Record<string, unknown>): { path?: string } => ({ path: str(s.path) }),
    component: function E() { const s = useSearch({ strict: false }) as { path?: string }; return <Suspense fallback={null}><ExportView path={s.path ?? ''} /></Suspense>; },
  }),
];

const router = createRouter({ routeTree: rootRoute.addChildren(routes), defaultPreload: 'intent', scrollRestoration: true });

declare module '@tanstack/react-router' {
  interface Register {
    router: typeof router;
  }
}

installSyncTriggers();

if ('serviceWorker' in navigator && import.meta.env.PROD) {
  void import('virtual:pwa-register').then(({ registerSW }) => registerSW({ immediate: true }));
}

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <QueryClientProvider client={queryClient}>
      <RouterProvider router={router} />
    </QueryClientProvider>
  </StrictMode>,
);
