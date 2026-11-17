// Typed items (the open-items index and checking items off) and the protected Sessions section.
import { Hono } from 'hono';
import { z } from 'zod';
import {
  ITEM_TYPES,
  reminderPast,
  editItem,
  itemLines,
  removeItem,
  setItemAnswer,
  setItemDone,
  setItemDue,
} from '@shared/items';
import { localClock } from '@shared/notify';
import { plainText } from '@shared/markdown';
import { ancestorsOf } from '@shared/tree';
import type { OpenItem, SessionEntry } from '@shared/types';
import { actorOf, isInternal } from '../auth';
import { all, getSetting } from '../db';
import { isTimeZone } from '../kit/push';
import {
  ConflictError,
  listSummaries,
  requirePage,
  sessionsRoot,
  subtreeIds,
  updatePage,
} from '../pages';
import { indexSoon } from '../search';
import { ensureItemsIndexed, logSession } from '../sessions';
import { ApiError, body, type AppEnv } from './util';

export const system = new Hono<AppEnv>();

/** Open items across the wiki (or with done ones), soonest due first (by date, then time). */
system.get('/items', async (c) => {
  const db = c.env.DB;
  await ensureItemsIndexed(db);
  const type = c.req.query('type');
  if (type && !(ITEM_TYPES as readonly string[]).includes(type))
    throw new ApiError(400, 'invalid', `type must be one of ${ITEM_TYPES.join(', ')}.`);
  const dueBefore = c.req.query('due_before');
  const includeDone = c.req.query('include_done') === '1';
  const under = c.req.query('under');
  // Archived pages are out of the wiki, and so are their items.
  const where = ['p.archived_at IS NULL'];
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
            i.due, i.due_time, i.done, i.answer
     FROM page_items i JOIN pages p ON p.id = i.page_id
     WHERE ${where.join(' AND ')}
     ORDER BY i.done, i.due IS NULL, i.due, i.due_time IS NOT NULL, i.due_time, p.updated_at DESC,
       i.line LIMIT 500`,
    ...binds,
  );
  let scope: Set<string> | null = null;
  if (under) scope = new Set(await subtreeIds(db, (await requirePage(db, under)).id));
  const pages = await listSummaries(db);
  const byId = new Map(pages.map((p) => [p.id, p]));
  // The owner's clock (the zone the app last reported): past reminders are left out, since a
  // reminder is a nudge with nothing left to do once its moment has gone by.
  const tz = await getSetting(db, 'tz');
  const now = localClock(new Date(), isTimeZone(tz) ? tz : 'UTC');
  const items: OpenItem[] = rows
    .filter((r) => !scope || scope.has(r.page_id))
    .filter((r) => includeDone || !reminderPast(r, now))
    .map((r) => ({
      ...r,
      done: !!r.done,
      path: ancestorsOf(r.page_id, byId).map((a) => a.title),
    }));
  return c.json({ items, today: now.date });
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

/** Change a to-do's or reminder's due date (and time), or clear a to-do's. */
system.post('/pages/:id/items/due', async (c) => {
  const { line, due, time } = await body(
    c,
    z.object({
      line: z.number().int().min(1),
      due: z
        .string()
        .regex(/^\d{4}-\d{2}-\d{2}$/)
        .nullable(),
      time: z
        .string()
        .regex(/^\d{1,2}:\d{2}$/)
        .nullable()
        .optional(),
    }),
  );
  const db = c.env.DB;
  for (let attempt = 0; ; attempt++) {
    const page = await requirePage(db, c.req.param('id'));
    const next = setItemDue(page.body, line, due, due ? (time ?? null) : null);
    if (next === null)
      throw new ApiError(
        409,
        'conflict',
        due ? 'That item has moved. Reload the page.' : 'Reminders need a due date.',
      );
    if (next === page.body) return c.json(page);
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

/** Edit an item from the app's item editor: its type, text, date and time. */
system.post('/pages/:id/items/edit', async (c) => {
  const input = await body(
    c,
    z.object({
      line: z.number().int().min(1),
      type: z.enum(ITEM_TYPES),
      text: z.string().min(1).max(2000),
      due: z
        .string()
        .regex(/^\d{4}-\d{2}-\d{2}$/)
        .nullable(),
      time: z
        .string()
        .regex(/^\d{1,2}:\d{2}$/)
        .nullable(),
    }),
  );
  const db = c.env.DB;
  for (let attempt = 0; ; attempt++) {
    const page = await requirePage(db, c.req.param('id'));
    const next = editItem(page.body, input.line, input);
    if (next === null)
      throw new ApiError(
        input.type === 'reminder' && !input.due ? 400 : 409,
        input.type === 'reminder' && !input.due ? 'invalid' : 'conflict',
        input.type === 'reminder' && !input.due
          ? 'Reminders need a date.'
          : 'That item has moved. Reload the page.',
      );
    if (next === page.body) return c.json(page);
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

/** Delete an item: its whole line comes out of the page. */
system.post('/pages/:id/items/delete', async (c) => {
  const { line } = await body(c, z.object({ line: z.number().int().min(1) }));
  const db = c.env.DB;
  for (let attempt = 0; ; attempt++) {
    const page = await requirePage(db, c.req.param('id'));
    const next = removeItem(page.body, line);
    if (next === null) throw new ApiError(409, 'conflict', 'That item has moved. Reload the page.');
    try {
      const saved = await updatePage(
        db,
        page.id,
        { body: next, base_version: page.version },
        { actor: actorOf(c.env) },
      );
      indexSoon(c.env, c.executionCtx);
      // The line as it was, so the app can offer Undo.
      return c.json({ ...saved, removed: itemLines(page.body, line).join('\n') });
    } catch (e) {
      if (e instanceof ConflictError && attempt < 2) continue;
      throw e;
    }
  }
});

/** The Sessions log, newest first. Entries from before v0.7 have no session row; their page stands in. */
system.get('/sessions', async (c) => {
  const db = c.env.DB;
  const root = await sessionsRoot(db);
  if (!root) return c.json({ root_id: null, entries: [] });
  const rows = await all<{
    id: string;
    title: string;
    body: string;
    created_by: string | null;
    created_at: string;
    updated_at: string;
    actor: string | null;
    started_at: string | null;
    last_at: string | null;
    summary: string | null;
  }>(
    db,
    `SELECT p.id, p.title, p.body, p.created_by, p.created_at, p.updated_at,
            s.actor, s.started_at, s.last_at, s.summary
     FROM pages p LEFT JOIN session_entries s ON s.page_id = p.id
     WHERE p.parent_id = ? ORDER BY COALESCE(s.started_at, p.created_at) DESC LIMIT 500`,
    root,
  );
  const entries: SessionEntry[] = rows.map((r) => {
    const [head = '', touched = ''] = r.body.split(/^## Pages touched\s*$/m);
    const summary = plainText(r.summary ?? head)
      .replace(/_[^_]*hasn’t added a summary yet\._/, '')
      .replace(/(^|\s)(?:[-*+]\s+)?(?:\[[ xX]\]\s+)?(?:todo|question|reminder):\s+/gi, '$1')
      .replace(/\s+/g, ' ')
      .trim();
    return {
      id: r.id,
      title: r.title.replace(/^\d{4}-\d{2}-\d{2}\s*·\s*/, ''),
      actor: r.actor ?? r.created_by,
      started_at: r.started_at ?? r.created_at,
      ended_at: r.last_at ?? r.updated_at,
      summary: summary.length > 240 ? `${summary.slice(0, 237)}…` : summary,
      pages: (touched.match(/^- (?!\(no page)/gm) ?? []).length,
    };
  });
  return c.json({ root_id: root, entries });
});

/** Answer a question where it's written (or clear the answer). */
system.post('/pages/:id/items/answer', async (c) => {
  const { line, answer } = await body(
    c,
    z.object({ line: z.number().int().min(1), answer: z.string().max(10_000) }),
  );
  const db = c.env.DB;
  for (let attempt = 0; ; attempt++) {
    const page = await requirePage(db, c.req.param('id'));
    const next = setItemAnswer(page.body, line, answer);
    if (next === null)
      throw new ApiError(409, 'conflict', 'That question has moved. Reload the page.');
    if (next === page.body) return c.json(page);
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
