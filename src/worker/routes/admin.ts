// Settings, search, backup and restore.
import { Hono } from 'hono';
import { extractLinks } from '@shared/markdown';
import { restoreInput, settingsInput } from '@shared/schemas';
import type { Backup, Page, SearchResponse } from '@shared/types';
import { all, chunks, getSetting, nowIso, setSettingStmt } from '../db';
import { indexSoon, resetIndex, search, searchStatus } from '../search';
import { ApiError, body, type AppEnv } from './util';

export const admin = new Hono<AppEnv>();

admin.get('/settings', async (c) => {
  return c.json({ home_id: await getSetting(c.env.DB, 'home_id') });
});

admin.patch('/settings', async (c) => {
  const input = await body(c, settingsInput);
  if (input.home_id !== undefined) await setSettingStmt(c.env.DB, 'home_id', input.home_id).run();
  return c.json({ ok: true });
});

admin.get('/search', async (c) => {
  const q = c.req.query('q') ?? '';
  const mode = (c.req.query('mode') ?? 'keyword') as SearchResponse['mode'];
  if (!['keyword', 'semantic', 'hybrid'].includes(mode))
    throw new ApiError(400, 'invalid', 'mode must be keyword, semantic or hybrid.');
  const limit = Math.min(50, Math.max(1, Number(c.req.query('limit') ?? 20) || 20));
  return c.json(await search(c.env, q, mode, limit));
});

admin.get('/search/status', async (c) => c.json(await searchStatus(c.env)));

admin.get('/backup', async (c) => {
  const pages = await all<Page>(
    c.env.DB,
    'SELECT id, parent_id, position, title, icon, body, version, created_at, updated_at FROM pages ORDER BY created_at',
  );
  const files = await all<Backup['files'][number]>(
    c.env.DB,
    'SELECT key, page_id, name, content_type, size FROM files',
  );
  const backup: Backup = {
    format: 'nitrogen-backup',
    version: 1,
    exported_at: nowIso(),
    pages,
    files,
  };
  c.header('Content-Disposition', `attachment; filename="nitrogen-${nowIso().slice(0, 10)}.json"`);
  return c.json(backup);
});

/** Replaces every page with the backup's. Images stay in R2; history starts fresh. */
admin.post('/restore', async (c) => {
  const input = await body(c, restoreInput);
  const db = c.env.DB;
  const ids = new Set(input.pages.map((p) => p.id));
  if (ids.size !== input.pages.length) throw new ApiError(400, 'invalid', 'Duplicate page ids.');

  // Parents before children; pages whose parent is missing become top level.
  const byParent = new Map<string | null, typeof input.pages>();
  for (const p of input.pages) {
    const parent = p.parent_id && ids.has(p.parent_id) ? p.parent_id : null;
    byParent.set(parent, [...(byParent.get(parent) ?? []), { ...p, parent_id: parent }]);
  }
  const ordered: typeof input.pages = [];
  const queue: (string | null)[] = [null];
  while (queue.length) {
    const kids = byParent.get(queue.shift()!) ?? [];
    ordered.push(...kids);
    queue.push(...kids.map((k) => k.id));
  }
  if (ordered.length !== input.pages.length)
    throw new ApiError(400, 'invalid', 'The backup’s page tree has a cycle.');

  await resetIndex(db);
  await db.batch([
    db.prepare('DELETE FROM links'),
    db.prepare('DELETE FROM page_revisions'),
    db.prepare('UPDATE files SET page_id = NULL'),
    // Children first for the self-referencing foreign key.
    db.prepare('DELETE FROM pages WHERE parent_id IS NOT NULL'),
    db.prepare('DELETE FROM pages'),
  ]);
  for (const part of chunks(ordered, 40)) {
    await db.batch(
      part.map((p) =>
        db
          .prepare(
            `INSERT INTO pages (id, parent_id, position, title, icon, body, version, created_at, updated_at)
             VALUES (?, ?, ?, ?, ?, ?, 1, ?, ?)`,
          )
          .bind(p.id, p.parent_id, p.position, p.title, p.icon, p.body, p.created_at, p.updated_at),
      ),
    );
  }

  // Links, resolved in memory against the restored titles.
  const byTitle = new Map<string, string>();
  for (const p of [...ordered].sort((a, b) => a.created_at.localeCompare(b.created_at)))
    if (!byTitle.has(p.title.toLowerCase())) byTitle.set(p.title.toLowerCase(), p.id);
  const links: [string, string][] = [];
  for (const p of ordered) {
    const { titles, ids: linked } = extractLinks(p.body);
    const dsts = new Set([
      ...titles.map((t) => byTitle.get(t)).filter((x): x is string => !!x),
      ...linked.filter((id) => ids.has(id)),
    ]);
    dsts.delete(p.id);
    dsts.forEach((d) => links.push([p.id, d]));
  }
  for (const part of chunks(links, 80))
    await db.batch(
      part.map(([s, d]) =>
        db.prepare('INSERT OR IGNORE INTO links (src, dst) VALUES (?, ?)').bind(s, d),
      ),
    );
  await db
    .prepare('UPDATE files SET page_id = NULL WHERE page_id NOT IN (SELECT id FROM pages)')
    .run();

  indexSoon(c.env, c.executionCtx);
  return c.json({ ok: true, pages: ordered.length });
});
