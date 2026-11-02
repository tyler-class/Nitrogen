import { Hono } from 'hono';
import type { Env } from './env.ts';
import { hmacHex, safeEqual } from './util/crypto.ts';
import { IndexStore } from './db/store.ts';
import { RepoService } from './repo/service.ts';
import { drain, handlePush, type PushPayload } from './repo/sync.ts';
import { branch } from './env.ts';

export const hookRoutes = new Hono<{ Bindings: Env }>();

hookRoutes.post('/github', async (c) => {
  const secret = c.env.GITHUB_WEBHOOK_SECRET;
  if (!secret) return c.json({ error: 'Webhook secret not configured.' }, 503);
  const raw = await c.req.text();
  const sig = c.req.header('x-hub-signature-256') ?? '';
  if (!safeEqual(sig, `sha256=${await hmacHex(secret, raw)}`)) return c.json({ error: 'Bad signature.' }, 401);
  const event = c.req.header('x-github-event');
  if (event === 'ping') return c.json({ ok: true });
  if (event !== 'push') return c.json({ ok: true, ignored: event });
  const payload = JSON.parse(raw) as PushPayload;
  const store = new IndexStore(c.env.DB);
  const r = await handlePush(store, branch(c.env), payload);
  const work = drain(new RepoService(c.env), store).catch((e) => console.error('drain failed', e));
  try {
    c.executionCtx.waitUntil(work);
  } catch {
    await work;
  }
  return c.json({ ok: true, queued: r.queued });
});
