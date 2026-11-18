import { ensureInstructions } from '../instructions';
import { Hono } from 'hono';
import {
  createPageInput,
  createTreeInput,
  archiveInput,
  movePageInput,
  pinInput,
  pinOrderInput,
  updatePageInput,
} from '@shared/schemas';
import type { TreeResponse } from '@shared/types';
import { nowIso } from '../db';
import {
  createPage,
  createTree,
  deletePage,
  getDetail,
  getRevision,
  listArchived,
  listRevisions,
  listSummaries,
  movePage,
  restoreRevision,
  sessionsRoot,
  setArchived,
  updatePage,
} from '../pages';
import { indexSoon } from '../search';
import { actorOf, isInternal } from '../auth';
import { deleteFiles } from './files';
import { ApiError, body, type AppEnv } from './util';

export const pages = new Hono<AppEnv>();

pages.get('/tree', async (c) => {
  // Made from the template the first time, so AI Instructions always has a page to edit.
  const guide = await ensureInstructions(c.env.DB);
  const [list, sessions, archived] = await Promise.all([
    listSummaries(c.env.DB),
    sessionsRoot(c.env.DB),
    listArchived(c.env.DB),
  ]);
  const instructionsId = list.some((p) => p.id === guide) ? guide : null;
  return c.json<TreeResponse>({
    pages: list,
    sessions_id: sessions,
    instructions_id: instructionsId,
    archived,
  });
});

/** The AI Instructions page's id (found by its role, made from the template if needed). */
pages.get('/ai-instructions', async (c) => c.json({ id: await ensureInstructions(c.env.DB) }));

pages.get('/pages/:id', async (c) => {
  const detail = await getDetail(c.env.DB, c.req.param('id'));
  return c.json(detail);
});

pages.post('/pages', async (c) => {
  const page = await createPage(c.env.DB, await body(c, createPageInput), actorOf(c.env));
  indexSoon(c.env, c.executionCtx);
  return c.json(page, 201);
});

pages.post('/pages/tree', async (c) => {
  const created = await createTree(c.env.DB, await body(c, createTreeInput), actorOf(c.env));
  indexSoon(c.env, c.executionCtx);
  return c.json({ created }, 201);
});

pages.patch('/pages/:id', async (c) => {
  const input = await body(c, updatePageInput);
  // Assistants always get a history snapshot so each of their edits can be undone.
  const page = await updatePage(c.env.DB, c.req.param('id'), input, {
    snapshot: isInternal(c.env),
    actor: actorOf(c.env),
  });
  indexSoon(c.env, c.executionCtx);
  return c.json(page);
});

pages.post('/pages/:id/move', async (c) => {
  const page = await movePage(
    c.env.DB,
    c.req.param('id'),
    await body(c, movePageInput),
    actorOf(c.env),
  );
  indexSoon(c.env, c.executionCtx);
  return c.json(page);
});

pages.delete('/pages/:id', async (c) => {
  const res = await deletePage(c.env.DB, c.req.param('id'), actorOf(c.env));
  await deleteFiles(c.env, res.orphanFiles);
  indexSoon(c.env, c.executionCtx);
  return c.json({ ok: true, deleted: res.deleted.length, images_removed: res.orphanFiles.length });
});

pages.get('/pages/:id/revisions', async (c) =>
  c.json({ revisions: await listRevisions(c.env.DB, c.req.param('id')) }),
);

pages.get('/pages/:id/revisions/:rev', async (c) => {
  const rev = Number(c.req.param('rev'));
  if (!Number.isInteger(rev)) throw new ApiError(400, 'invalid', 'Bad revision id.');
  return c.json(await getRevision(c.env.DB, c.req.param('id'), rev));
});

pages.post('/pages/:id/revisions/:rev/restore', async (c) => {
  const rev = Number(c.req.param('rev'));
  if (!Number.isInteger(rev)) throw new ApiError(400, 'invalid', 'Bad revision id.');
  const page = await restoreRevision(c.env.DB, c.req.param('id'), rev, actorOf(c.env));
  indexSoon(c.env, c.executionCtx);
  return c.json(page);
});

/** Archive a page with everything inside it, or restore it. Not a content change. */
pages.post('/pages/:id/archive', async (c) => {
  const { archived } = await body(c, archiveInput);
  const page = await setArchived(c.env.DB, c.req.param('id'), archived);
  return c.json(page);
});

/** Pinned pages show on Home. Not a content change: no history or event. */
pages.post('/pages/:id/pin', async (c) => {
  const { pinned } = await body(c, pinInput);
  const res = await c.env.DB.prepare('UPDATE pages SET pinned_at = ? WHERE id = ?')
    .bind(pinned ? nowIso() : null, c.req.param('id'))
    .run();
  if (!res.meta.changes) throw new ApiError(404, 'not_found', 'Page not found.');
  return c.json({ ok: true, pinned });
});

/**
 * Reorder the pinned pages (Home lists them by pinned_at): the given pinned pages get pinned_at
 * one millisecond apart in the new order, starting at the earliest they had, so later pins still
 * land at the end. Ids that aren't pinned are skipped.
 */
pages.post('/pinned/order', async (c) => {
  const { ids } = await body(c, pinOrderInput);
  const db = c.env.DB;
  const pinned = (
    await db.prepare('SELECT id, pinned_at FROM pages WHERE pinned_at IS NOT NULL').all<{
      id: string;
      pinned_at: string;
    }>()
  ).results;
  const known = new Set(pinned.map((p) => p.id));
  const order = [...new Set(ids)].filter((id) => known.has(id));
  if (!order.length) return c.json({ ok: true });
  const start = Math.min(...pinned.map((p) => Date.parse(p.pinned_at)));
  await db.batch(
    order.map((id, k) =>
      db
        .prepare('UPDATE pages SET pinned_at = ? WHERE id = ?')
        .bind(new Date(start + k).toISOString(), id),
    ),
  );
  return c.json({ ok: true });
});
