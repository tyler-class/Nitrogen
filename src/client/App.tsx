import { QueryClient, QueryClientProvider, useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect } from 'react';
import { createBrowserRouter, Navigate, RouterProvider } from 'react-router';
import { api, ApiError, onUnauthorized } from './lib/api';
import { startPwa } from './lib/pwa';
import { ToastProvider } from './components/Toast';
import { Activity } from './routes/Activity';
import { Home } from './routes/Home';
import { Insights } from './routes/Insights';
import { Layout } from './routes/Layout';
import { Login, SetupNeeded } from './routes/Login';
import { PageView } from './routes/PageView';
import { SearchPage } from './routes/SearchPage';
import { Sessions } from './routes/Sessions';
import { Settings } from './routes/Settings';
import { Tags } from './routes/Tags';

const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      retry: (n, e) => !(e instanceof ApiError && [401, 403, 404, 503].includes(e.status)) && n < 2,
      refetchOnWindowFocus: true,
    },
  },
});

startPwa();

const router = createBrowserRouter([
  {
    element: <Layout />,
    children: [
      { path: '/', element: <Home /> },
      { path: '/p/:id/*', element: <PageView /> },
      { path: '/search', element: <SearchPage /> },
      { path: '/settings', element: <Settings /> },
      // Home used to be called the dashboard; old links still land there.
      { path: '/dashboard', element: <Navigate to="/" replace /> },
      { path: '/activity', element: <Activity /> },
      { path: '/insights', element: <Insights /> },
      { path: '/sessions', element: <Sessions /> },
      { path: '/sessions/:id', element: <Sessions /> },
      { path: '/tags', element: <Tags /> },
      { path: '/tags/:tag', element: <Tags /> },
      { path: '*', element: <Home /> },
    ],
  },
]);

function Gate() {
  const qc = useQueryClient();
  const session = useQuery({
    queryKey: ['session'],
    queryFn: () => api.get<{ ok: true }>('/session'),
    retry: false,
    staleTime: Infinity,
    refetchOnWindowFocus: false,
  });
  useEffect(
    () =>
      onUnauthorized(() => {
        qc.setQueryData(['session'], null);
        void qc.invalidateQueries({ queryKey: ['session'] });
      }),
    [qc],
  );
  if (session.isPending) return <div className="page-loading" />;
  const err = session.error;
  if (err instanceof ApiError && err.status === 503) return <SetupNeeded message={err.message} />;
  if (err instanceof ApiError && err.status === 0) return <RouterProvider router={router} />;
  if (err || !session.data) return <Login />;
  return <RouterProvider router={router} />;
}

export function App() {
  return (
    <QueryClientProvider client={queryClient}>
      <ToastProvider>
        <Gate />
      </ToastProvider>
    </QueryClientProvider>
  );
}
