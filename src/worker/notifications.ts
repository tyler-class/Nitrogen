// Nitrogen's notifications on top of the Selfhost Kit's push (src/worker/kit/push.ts): what a
// device gets, and the app-icon count. This file only loads data; which notifications are due and
// what they say are pure functions in src/shared/notify.ts.
import { Hono } from 'hono';
import { z } from 'zod';
import type { InboxNotice } from '@shared/types';
import {
  assistantWindow,
  DATED_TYPES,
  localClock,
  noticesNow,
  NOTIFY_KINDS,
  type AssistantEvent,
  type AssistantWindow,
  type DatedItem,
  type Notice,
} from '@shared/notify';
import { all, first, getSetting, nowIso, setSettingStmt } from './db';
import { ApiError, body, type AppEnv } from './routes/util';
import { ensureItemsIndexed } from './sessions';
import {
  isTimeZone,
  listDevices,
  localDate,
  pushRoutes,
  runPushJob,
  type PushCandidate,
  type PushDevice,
  type PushJobOptions,
} from './kit/push';

const ICON = '/icons/icon-192.png';

/** Open dated to-dos and reminders, and open questions, from the items index. */
async function loadOpen(db: D1Database): Promise<DatedItem[]> {
  await ensureItemsIndexed(db);
  const rows = await all<Omit<DatedItem, 'done'>>(
    db,
    `SELECT i.page_id, p.title AS page_title, i.line, i.type, i.text, i.due, i.due_time
     FROM page_items i JOIN pages p ON p.id = i.page_id
     WHERE i.done = 0 AND (i.type = 'question'
       OR (i.due IS NOT NULL AND i.type IN (${DATED_TYPES.map(() => '?').join(', ')})))`,
    ...DATED_TYPES,
  );
  return rows.map((r) => ({ ...r, done: false }));
}

/**
 * What assistants did in a window, newest first: the activity log's rows with an "agent:" actor
 * (MCP writes; the app's own edits are "you"). Sessions entries aren't in the log, but the
 * Sessions page itself is left out too.
 */
async function loadAssistantEvents(db: D1Database, w: AssistantWindow): Promise<AssistantEvent[]> {
  const sessions =
    (await first<{ value: string }>(db, "SELECT value FROM settings WHERE key = 'sessions_id'"))
      ?.value ?? '';
  const rows = await all<Omit<AssistantEvent, 'live'> & { live: number }>(
    db,
    `SELECT e.page_id, COALESCE(p.title, e.title) AS title, e.action, e.actor,
            (p.id IS NOT NULL AND e.action != 'delete') AS live
     FROM page_events e LEFT JOIN pages p ON p.id = e.page_id
     WHERE e.actor LIKE 'agent:%' AND e.created_at >= ? AND e.created_at < ?
       AND e.page_id != ? AND (p.parent_id IS NULL OR p.parent_id != ?)
     ORDER BY e.created_at DESC, e.id DESC`,
    w.from.toISOString(),
    w.to.toISOString(),
    sessions,
    sessions,
  );
  return rows.map((r) => ({ ...r, live: !!r.live }));
}

const candidate = (n: Notice): PushCandidate => ({
  kind: n.kind,
  key: n.key,
  message: { title: n.title, body: n.body, url: n.url, tag: n.tag },
});

/** The notifications a device could get now, and its badge count. Data loads once per run. */
export function nitrogenPush(db: D1Database): Pick<PushJobOptions, 'build' | 'badge'> {
  let items: Promise<DatedItem[]> | null = null;
  const load = () => (items ??= loadOpen(db));
  const events = new Map<string, Promise<AssistantEvent[]>>();
  const loadEvents = (w: AssistantWindow) => {
    const k = `${w.from.toISOString()}|${w.key}`;
    if (!events.has(k)) events.set(k, loadAssistantEvents(db, w));
    return events.get(k)!;
  };
  return {
    async build(device: PushDevice, now: Date) {
      const w = device.prefs.assistant === false ? null : assistantWindow(now, device.tz);
      const notices = noticesNow(
        await load(),
        localClock(now, device.tz),
        w ? await loadEvents(w) : [],
        w,
      );
      return notices.map(candidate);
    },
    async badge() {
      return unreadCount(db);
    },
  };
}

/**
 * The cron's notification run (every 15 minutes). The kit's own 8 a.m. gate is opened all day
 * (hour 0): noticesNow decides the time for each kind (8 a.m. for the morning ones, an item's
 * own time for timed ones, hourly for assistant changes). Morning ones only go out from 8 to
 * 10 a.m.: something that turns up later in the day waits for the next morning.
 */
export async function runNotifications(db: D1Database, o: Partial<PushJobOptions> = {}) {
  // The list first, so the badge sent with each push already counts what it's about.
  try {
    await recordInbox(db, o.now ?? new Date());
  } catch (e) {
    console.warn('notifications: inbox failed', e);
  }
  return runPushJob(db, { ...nitrogenPush(db), icon: ICON, hour: 0, until: 24, ...o });
}

// ---------------------------------------------------------------------------------------------
// The in-app list (the bell)

/** Notifications older than this are dropped. */
const KEEP_DAYS = 60;

/**
 * The time zones to follow: what the app last reported (the owner's clock, even with no device
 * set up for push) and each device's, so anything a phone is sent is in the list too. One owner
 * normally means one zone.
 */
async function inboxZones(db: D1Database): Promise<string[]> {
  const tz = await getSetting(db, 'tz');
  const zones = new Set<string>(isTimeZone(tz) ? [tz] : []);
  for (const d of await listDevices(db)) if (d.prefs.enabled) zones.add(d.tz);
  if (!zones.size) zones.add('UTC');
  return [...zones];
}

/**
 * Adds every notification due now to the list, once each (all kinds, whatever a device has
 * switched off), whether or not any device is set up for push. Old ones are dropped.
 */
export async function recordInbox(db: D1Database, now: Date): Promise<number> {
  const items = await loadOpen(db);
  const at = now.toISOString();
  const stmts: D1PreparedStatement[] = [];
  for (const tz of await inboxZones(db)) {
    const w = assistantWindow(now, tz);
    const notices = noticesNow(
      items,
      localClock(now, tz),
      w ? await loadAssistantEvents(db, w) : [],
      w,
    );
    const date = localDate(now, tz);
    for (const n of notices)
      stmts.push(
        db
          .prepare(
            `INSERT INTO notifications (kind, key, title, body, url, created_at)
             VALUES (?, ?, ?, ?, ?, ?) ON CONFLICT (key) DO NOTHING`,
          )
          .bind(n.kind, `${n.kind}:${n.key}:${date}`, n.title, n.body, n.url, at),
      );
  }
  const added = stmts.length;
  stmts.push(
    db
      .prepare('DELETE FROM notifications WHERE created_at < ?')
      .bind(new Date(now.getTime() - KEEP_DAYS * 86_400_000).toISOString()),
  );
  const res = await db.batch(stmts);
  return res.slice(0, added).reduce((n, r) => n + (r.meta.changes ?? 0), 0);
}

/** The app-icon count: unread notifications. */
export async function unreadCount(db: D1Database): Promise<number> {
  return (
    (
      await first<{ n: number }>(
        db,
        'SELECT COUNT(*) AS n FROM notifications WHERE read_at IS NULL',
      )
    )?.n ?? 0
  );
}

const LIST_LIMIT = 50;

/** /api/notifications: the bell's list, and marking read or unread. */
export const inbox = new Hono<AppEnv>();

inbox.get('/notifications', async (c) => {
  const db = c.env.DB;
  // The app reports its time zone, so the list follows the owner's clock without any setup.
  const tz = c.req.query('tz');
  if (isTimeZone(tz) && tz !== (await getSetting(db, 'tz')))
    await setSettingStmt(db, 'tz', tz).run();
  const rows = await all<Omit<InboxNotice, 'read'> & { read_at: string | null }>(
    db,
    `SELECT id, kind, title, body, url, created_at, read_at FROM notifications
     ORDER BY created_at DESC, id DESC LIMIT ?`,
    LIST_LIMIT,
  );
  return c.json({
    items: rows.map(({ read_at, ...r }) => ({ ...r, read: !!read_at })),
    unread: await unreadCount(db),
  });
});

inbox.post('/notifications/:id/read', async (c) => {
  const id = Number(c.req.param('id'));
  if (!Number.isInteger(id)) throw new ApiError(400, 'invalid', 'Bad notification id.');
  const { read } = await body(c, z.object({ read: z.boolean() }));
  const r = await c.env.DB.prepare('UPDATE notifications SET read_at = ? WHERE id = ?')
    .bind(read ? nowIso() : null, id)
    .run();
  if (!r.meta.changes) throw new ApiError(404, 'not_found', 'Notification not found.');
  return c.json({ unread: await unreadCount(c.env.DB) });
});

inbox.post('/notifications/read-all', async (c) => {
  await c.env.DB.prepare('UPDATE notifications SET read_at = ? WHERE read_at IS NULL')
    .bind(nowIso())
    .run();
  return c.json({ unread: 0 });
});

/** /api/push/*: behind Nitrogen's sign-in (mounted after the guard in app.ts). */
export const push = pushRoutes({
  title: 'Nitrogen',
  kinds: NOTIFY_KINDS.map((k) => k.id),
  icon: ICON,
  fallbackSubject: 'mailto:nitrogen@tylerclass.net',
  badge: (_device, _now, db) => unreadCount(db),
});
