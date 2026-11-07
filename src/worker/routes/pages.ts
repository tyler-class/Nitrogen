import { Hono } from 'hono';
import {
  createPageInput,
  createTreeInput,
  movePageInput,
  pinInput,
  updatePageInput,
} from '@shared/schemas';
import type { TreeResponse } from '@shared/types';
import { getSetting, nowIso } from '../db';
import {
  createPage,
  createTree,
  deletePage,
  getDetail,
  getRevision,
  listRevisions,
  listSummaries,
  movePage,
  restoreRevision,
  sessionsRoot,
  updatePage,
} from '../pages';
import { indexSoon } from '../search';
import { actorOf, isInternal } from '../auth';
import { deleteFiles } from './files';
import { ApiError, body, type AppEnv } from './util';

export const pages = new Hono<AppEnv>();

pages.get('/tree', async (c) => {
  const [list, home, sessions] = await Promise.all([
    listSummaries(c.env.DB),
    getSetting(c.env.DB, 'home_id'),
    sessionsRoot(c.env.DB),
  ]);
  const homeId = home && list.some((p) => p.id === home) ? home : null;
  return c.json<TreeResponse>({ pages: list, home_id: homeId, sessions_id: sessions });
});

pages.get('/pages/:id', async (c) => {
  const detail = await getDetail(c.env.DB, c.req.param('id'));
  // The owner opening a page clears it from the inbox; assistants reading it, and previews
  // (?peek=1, e.g. the graph's side card), don't.
  if (!isInternal(c.env) && c.req.query('peek') !== '1')
    c.executionCtx.waitUntil(
      c.env.DB.prepare('UPDATE pages SET viewed_at = ? WHERE id = ?')
        .bind(nowIso(), detail.page.id)
        .run(),
    );
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

/** Pinned pages show on the dashboard. Not a content change: no history or event. */
pages.post('/pages/:id/pin', async (c) => {
  const { pinned } = await body(c, pinInput);
  const res = await c.env.DB.prepare('UPDATE pages SET pinned_at = ? WHERE id = ?')
    .bind(pinned ? nowIso() : null, c.req.param('id'))
    .run();
  if (!res.meta.changes) throw new ApiError(404, 'not_found', 'Page not found.');
  return c.json({ ok: true, pinned });
});
