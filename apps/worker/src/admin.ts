/** /admin/ingest: HMAC-signed index batches from the notes-repo Action (full parser, no CPU limit). */
import { Hono } from 'hono';
import type { Env } from './env.ts';
import { hmacHex, safeEqual } from './util/crypto.ts';
import { IndexStore, type IngestRows } from './db/store.ts';

export interface IngestBody {
  head: string | null;
  mode: 'full';
  batch: number;
  of: number;
  allPaths: string[];
  pages: IngestRows[];
  config?: string | null;
  assets?: { path: string; sha: string; size: number }[];
}

export const adminRoutes = new Hono<{ Bindings: Env }>();

adminRoutes.post('/ingest', async (c) => {
  const secret = c.env.INGEST_HMAC_SECRET;
  if (!secret) return c.json({ error: 'Ingest secret not configured.' }, 503);
  const ts = c.req.header('x-nitrogen-timestamp') ?? '';
  const sig = c.req.header('x-nitrogen-signature') ?? '';
  const raw = await c.req.text();
  const age = Math.abs(Date.now() / 1000 - Number(ts));
  if (!/^\d+$/.test(ts) || age > 300) return c.json({ error: 'Stale or missing timestamp.' }, 401);
  if (!safeEqual(sig, `sha256=${await hmacHex(secret, `${ts}.${raw}`)}`)) return c.json({ error: 'Bad signature.' }, 401);
  const body = JSON.parse(raw) as IngestBody;
  const store = new IndexStore(c.env.DB);
  const stmts: D1PreparedStatement[] = [];
  if (body.config !== undefined && body.config !== null) stmts.push(store.setMetaStmt('config', body.config));
  if (body.assets) {
    stmts.push(store.db.prepare('DELETE FROM assets'));
    for (const a of body.assets) stmts.push(store.db.prepare('INSERT INTO assets (path, sha, size) VALUES (?, ?, ?)').bind(a.path, a.sha, a.size));
  }
  const existing = await store.pageShas();
  for (const p of body.pages) if (existing.get(p.page.path) !== p.page.sha) stmts.push(...store.pageStatements(p));
  if (body.batch === body.of) {
    const keep = new Set(body.allPaths);
    for (const path of existing.keys()) if (!keep.has(path)) stmts.push(...store.deletePageStatements(path));
    if (body.head) stmts.push(store.setMetaStmt('head', body.head));
    stmts.push(store.setMetaStmt('last_full_index', new Date().toISOString()));
    stmts.push(store.db.prepare('DELETE FROM reindex_queue'));
  }
  await store.run(stmts);
  return c.json({ ok: true, written: body.pages.length, batch: body.batch, of: body.of });
});
