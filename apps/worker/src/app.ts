import { Hono } from 'hono';
import type { Env } from './env.ts';
import { api } from './api/routes.ts';
import { loginRoutes } from './auth/github-login.ts';
import { hookRoutes } from './hooks.ts';
import { adminRoutes } from './admin.ts';
import { securityHeaders } from './util/http.ts';

export function createApp() {
  const app = new Hono<{ Bindings: Env }>();
  app.use('/api/*', securityHeaders);
  app.use('/auth/*', securityHeaders);
  app.use('/hooks/*', securityHeaders);
  app.use('/admin/*', securityHeaders);
  app.route('/api', api);
  app.route('/auth', loginRoutes);
  app.route('/hooks', hookRoutes);
  app.route('/admin', adminRoutes);
  app.all('*', async (c) => {
    if (c.env.ASSETS) return c.env.ASSETS.fetch(c.req.raw);
    return c.text('Not found', 404);
  });
  return app;
}

export const app = createApp();
