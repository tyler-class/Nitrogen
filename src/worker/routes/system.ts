// Typed items (the open-items index and checking items off) and the protected Sessions section.
import { Hono } from 'hono';
import { z } from 'zod';
import { ITEM_TYPES, setItemDone } from '@shared/items';
import { ancestorsOf } from '@shared/tree';
import type { OpenItem } from '@shared/types';
import { actorOf, isInternal } from '../auth';
import { all } from '../db';
import {
  ConflictError,
  deletePage,
  listSummaries,
  protection,
  requirePage,
  subtreeIds,
  updatePage,
} from '../pages';
import { indexSoon } from '../search';
import { ensureItemsIndexed, logSession } from '../sessions';
import { deleteFiles } from './files';
import { ApiError, body, type AppEnv } from './util';

export const system = new Hono<AppEnv>();

/** Open items across the wiki (or with done ones), soonest due first. */
system.get('/items', async (c) => {
  const db = c.env.DB;
  await ensureItemsIndexed(db);
  const type = c.req.query('type');
  if (type && !(ITEM_TYPES as readonly string[]).includes(type))
    throw new ApiError(400, 'invalid', `type must be one of ${ITEM_TYPES.join(', ')}.`);
  const dueBefore = c.req.query('due_before');
  const includeDone = c.req.query('include_done') === '1';
  const under = c.req.query('under');
  const where = ['1 = 1'];
  const binds: unknown[] = [];
  if (!includeDone) where.push('i.done = 0');
  if (type) {
    where.push('i.type = ?');
    binds.push(type);
  }
  if (dueBefore) {
    where.push('i.due IS NOT NULL AND i.due <= ?');
    binds.push(dueBefore);
  }
  const rows = await all<Omit<OpenItem, 'path' | 'done'> & { done: number }>(
    db,
    `SELECT i.page_id, p.title AS page_title, p.icon AS page_icon, i.line, i.type, i.text, i.owner,
            i.due, i.done, i.answer
     FROM page_items i JOIN pages p ON p.id = i.page_id
     WHERE ${where.join(' AND ')}
     ORDER BY i.done, i.due IS NULL, i.due, p.updated_at DESC, i.line LIMIT 500`,
    ...binds,
  );
  let scope: Set<string> | null = null;
  if (under) scope = new Set(await subtreeIds(db, (await requirePage(db, under)).id));
  const pages = await listSummaries(db);
  const byId = new Map(pages.map((p) => [p.id, p]));
  const items: OpenItem[] = rows
    .filter((r) => !scope || scope.has(r.page_id))
    .map((r) => ({
      ...r,
      done: !!r.done,
      path: ancestorsOf(r.page_id, byId).map((a) => a.title),
    }));
  return c.json({ items });
});

/** Check an item off (or back on) where it's written. */
system.post('/pages/:id/items/toggle', async (c) => {
  const { line, done } = await body(
    c,
    z.object({ line: z.number().int().min(1), done: z.boolean() }),
  );
  const db = c.env.DB;
  for (let attempt = 0; ; attempt++) {
    const page = await requirePage(db, c.req.param('id'));
    const next = setItemDone(page.body, line, done);
    if (next === null) throw new ApiError(409, 'conflict', 'That item has moved. Reload the page.');
    try {
      const saved = await updatePage(
        db,
        page.id,
        { body: next, base_version: page.version },
        { actor: actorOf(c.env) },
      );
      indexSoon(c.env, c.executionCtx);
      return c.json(saved);
    } catch (e) {
      if (e instanceof ConflictError && attempt < 2) continue;
      throw e;
    }
  }
});

/** log_session: an assistant's title and summary for its current session (MCP only). */
system.post('/sessions/log', async (c) => {
  if (!isInternal(c.env))
    throw new ApiError(403, 'forbidden', 'Only assistants write session entries.');
  const input = await body(
    c,
    z.object({
      title: z.string().trim().min(1).max(120),
      summary: z.string().trim().min(1).max(20_000),
    }),
  );
  const res = await logSession(c.env.DB, actorOf(c.env), input.title, input.summary);
  indexSoon(c.env, c.executionCtx);
  return c.json(res);
});

/** The owner's maintenance action: remove a bad or sensitive session entry. */
system.delete('/sessions/:id', async (c) => {
  if (isInternal(c.env))
    throw new ApiError(403, 'forbidden', 'Only the owner can purge a session entry.');
  const db = c.env.DB;
  const id = c.req.param('id');
  if ((await protection(db, id)) !== 'entry')
    throw new ApiError(400, 'invalid', 'That page isn’t a session entry.');
  const res = await deletePage(db, id, actorOf(c.env), { purge: true });
  await deleteFiles(c.env, res.orphanFiles);
  indexSoon(c.env, c.executionCtx);
  return c.json({ ok: true });
});
