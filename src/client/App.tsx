import { QueryClient, QueryClientProvider, useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect } from 'react';
import { createBrowserRouter, RouterProvider } from 'react-router';
import { registerSW } from 'virtual:pwa-register';
import { api, ApiError, onUnauthorized } from './lib/api';
import { ToastProvider } from './components/Toast';
import { Home } from './routes/Home';
import { Layout } from './routes/Layout';
import { Login, SetupNeeded } from './routes/Login';
import { PageView } from './routes/PageView';
import { SearchPage } from './routes/SearchPage';
import { Settings } from './routes/Settings';

const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      retry: (n, e) => !(e instanceof ApiError && [401, 403, 404, 503].includes(e.status)) && n < 2,
      refetchOnWindowFocus: true,
    },
  },
});

registerSW({ immediate: true });

const router = createBrowserRouter([
  {
    element: <Layout />,
    children: [
      { path: '/', element: <Home /> },
      { path: '/p/:id/*', element: <PageView /> },
      { path: '/search', element: <SearchPage /> },
      { path: '/settings', element: <Settings /> },
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
