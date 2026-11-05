// Settings, search, backup and restore.
import { Hono } from 'hono';
import { encodeActor } from '@shared/actor';
import { ancestorsOf } from '@shared/tree';
import { extractLinks, extractTags, normalizeTag, wordCount } from '@shared/markdown';
import { panelLayoutInput, restoreInput, settingsInput } from '@shared/schemas';
import type { Backup, PanelLayout, SearchHit, SearchResponse } from '@shared/types';
import { actorOf, isInternal } from '../auth';
import { all, chunks, getSetting, nowIso, setSettingStmt } from '../db';
import { hydrate, listSummaries } from '../pages';
import { indexSoon, resetIndex, search, searchStatus } from '../search';
import { ApiError, body, type AppEnv } from './util';

export const admin = new Hono<AppEnv>();

/** A saved panel layout; anything malformed is dropped so the app falls back to defaults. */
export async function panelLayout(db: D1Database, key: string): Promise<PanelLayout[]> {
  try {
    const r = panelLayoutInput.safeParse(JSON.parse((await getSetting(db, key)) ?? '[]'));
    return r.success ? r.data : [];
  } catch {
    return [];
  }
}

admin.get('/settings', async (c) => {
  const [home, guide, dashboard_layout, insights_layout] = await Promise.all([
    getSetting(c.env.DB, 'home_id'),
    getSetting(c.env.DB, 'guide_id'),
    panelLayout(c.env.DB, 'dashboard_layout'),
    panelLayout(c.env.DB, 'insights_layout'),
  ]);
  return c.json({ home_id: home, guide_id: guide, dashboard_layout, insights_layout });
});

admin.patch('/settings', async (c) => {
  const input = await body(c, settingsInput);
  const stmts = [];
  if (input.home_id !== undefined) stmts.push(setSettingStmt(c.env.DB, 'home_id', input.home_id));
  if (input.guide_id !== undefined)
    stmts.push(setSettingStmt(c.env.DB, 'guide_id', input.guide_id));
  for (const key of ['dashboard_layout', 'insights_layout'] as const)
    if (input[key] !== undefined)
      stmts.push(setSettingStmt(c.env.DB, key, JSON.stringify(input[key])));
  if (stmts.length) await c.env.DB.batch(stmts);
  return c.json({ ok: true });
});

admin.get('/search', async (c) => {
  const q = c.req.query('q') ?? '';
  const mode = (c.req.query('mode') ?? 'keyword') as SearchResponse['mode'];
  if (!['keyword', 'semantic', 'hybrid'].includes(mode))
    throw new ApiError(400, 'invalid', 'mode must be keyword, semantic or hybrid.');
  const limit = Math.min(50, Math.max(1, Number(c.req.query('limit') ?? 20) || 20));
  const tag = normalizeTag(c.req.query('tag') ?? '');
  let res: SearchResponse;
  if (tag) {
    const tagged = new Set(
      (
        await all<{ page_id: string }>(c.env.DB, 'SELECT page_id FROM page_tags WHERE tag = ?', tag)
      ).map((r) => r.page_id),
    );
    if (q.trim()) {
      res = await search(c.env, q, mode, 50);
      res = { ...res, hits: res.hits.filter((h) => tagged.has(h.id)).slice(0, limit) };
    } else {
      // No words: every page with the tag, most recently changed first.
      const list = await listSummaries(c.env.DB);
      const byId = new Map(list.map((p) => [p.id, p]));
      res = {
        query: '',
        mode,
        hits: list
          .filter((p) => tagged.has(p.id))
          .sort((a, b) => b.updated_at.localeCompare(a.updated_at))
          .slice(0, limit)
          .map((p): SearchHit => ({
            id: p.id,
            title: p.title,
            icon: p.icon,
            snippet: '',
            path: ancestorsOf(p.id, byId).map((a) => a.title),
            score: 1,
            source: 'keyword',
          })),
      };
    }
  } else res = await search(c.env, q, mode, limit);

  // Remember what assistants looked for, to show what the wiki couldn't answer.
  if (isInternal(c.env) && q.trim())
    c.executionCtx.waitUntil(
      c.env.DB.batch([
        c.env.DB.prepare(
          'INSERT INTO search_log (query, actor, hits, created_at) VALUES (?, ?, ?, ?)',
        ).bind(q.trim().slice(0, 300), encodeActor(actorOf(c.env)), res.hits.length, nowIso()),
        c.env.DB.prepare(
          'DELETE FROM search_log WHERE id NOT IN (SELECT id FROM search_log ORDER BY id DESC LIMIT 2000)',
        ),
      ]),
    );
  return c.json(res);
});

admin.get('/search/status', async (c) => c.json(await searchStatus(c.env)));

admin.get('/backup', async (c) => {
  const pages = await all(
    c.env.DB,
    'SELECT id, parent_id, position, title, icon, body, version, created_at, updated_at, created_by, updated_by, pinned_at, tags, words FROM pages ORDER BY created_at',
  ).then((rows) => rows.map((r) => hydrate(r as never)));
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
    db.prepare('DELETE FROM page_tags'),
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
            `INSERT INTO pages (id, parent_id, position, title, icon, body, version, created_at, updated_at,
               created_by, updated_by, viewed_at, pinned_at, tags, words)
             VALUES (?, ?, ?, ?, ?, ?, 1, ?, ?, ?, ?, ?, ?, ?, ?)`,
          )
          .bind(
            p.id,
            p.parent_id,
            p.position,
            p.title,
            p.icon,
            p.body,
            p.created_at,
            p.updated_at,
            p.created_by ?? null,
            p.updated_by ?? null,
            p.updated_at,
            p.pinned_at ?? null,
            JSON.stringify(p.tags ?? []),
            wordCount(p.body),
          ),
      ),
    );
  }
  const tagRows = ordered.flatMap((p) =>
    [...new Set([...(p.tags ?? []), ...extractTags(p.body)])].map((t) => [p.id, t] as const),
  );
  for (const part of chunks(tagRows, 80))
    await db.batch(
      part.map(([id, t]) =>
        db.prepare('INSERT OR IGNORE INTO page_tags (page_id, tag) VALUES (?, ?)').bind(id, t),
      ),
    );

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
