// Nitrogen's notifications on top of the Selfhost Kit's push (src/worker/kit/push.ts): what a
// device gets, and the app-icon count. This file only loads data; which notifications are due and
// what they say are pure functions in src/shared/notify.ts.
import { Hono } from 'hono';
import { z } from 'zod';
import type { InboxNotice } from '@shared/types';
import {
  assistantReady,
  assistantWindow,
  DATED_TYPES,
  localClock,
  MORNING_HOUR,
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
     WHERE i.done = 0 AND p.archived_at IS NULL AND (i.type = 'question'
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
async function loadAssistantEvents(
  db: D1Database,
  w: Pick<AssistantWindow, 'from' | 'to'>,
): Promise<AssistantEvent[]> {
  const sessions =
    (await first<{ value: string }>(db, "SELECT value FROM settings WHERE key = 'sessions_id'"))
      ?.value ?? '';
  const rows = await all<Omit<AssistantEvent, 'live'> & { live: number }>(
    db,
    `SELECT e.page_id, COALESCE(p.title, e.title) AS title, e.action, e.actor, e.created_at AS at,
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

/** Where the last assistant-changes report ended: the next one covers what came after. */
const CURSOR = 'assistant_reported_to';
/** With no report yet, a first one looks back this far. */
const FIRST_LOOKBACK_MS = 3 * 3_600_000;

/** One run's assistant edits: those since the last report, and whether they're ready to send. */
interface AssistantPlan {
  since: Date;
  events: AssistantEvent[];
  ready: boolean;
}

async function assistantPlan(db: D1Database, now: Date): Promise<AssistantPlan> {
  const saved = await getSetting(db, CURSOR);
  const t = saved ? Date.parse(saved) : NaN;
  const since = Number.isFinite(t) ? new Date(t) : new Date(now.getTime() - FIRST_LOOKBACK_MS);
  const events = since < now ? await loadAssistantEvents(db, { from: since, to: now }) : [];
  return { since, events, ready: assistantReady(events, now) };
}

const windowFor = (plan: AssistantPlan, now: Date, tz: string) =>
  assistantWindow(plan.events, plan.since, now, tz);

/**
 * The notifications a device could get now, and its badge count. Data loads once per run; the
 * assistant plan is the run's own (runNotifications) or, used alone, worked out here.
 */
export function nitrogenPush(
  db: D1Database,
  plan?: Promise<AssistantPlan>,
): Pick<PushJobOptions, 'build' | 'badge'> {
  let items: Promise<DatedItem[]> | null = null;
  const load = () => (items ??= loadOpen(db));
  let own: Promise<AssistantPlan> | null = plan ?? null;
  return {
    async build(device: PushDevice, now: Date) {
      own ??= assistantPlan(db, now);
      const p = await own;
      const w = device.prefs.assistant === false ? null : windowFor(p, now, device.tz);
      const notices = noticesNow(await load(), localClock(now, device.tz), w ? p.events : [], w);
      return notices.map(candidate);
    },
    async badge() {
      return unreadCount(db);
    },
  };
}

/**
 * The cron's notification run (every 5 minutes). The kit's own 8 a.m. gate is opened all day
 * (hour 0): noticesNow decides the time for each kind (8 a.m. for the morning ones, an item's
 * own time for timed ones, a few minutes after an assistant finishes for assistant changes).
 * Morning ones only go out from 8 to 10 a.m.: something that turns up later waits for the next
 * morning.
 */
export async function runNotifications(db: D1Database, o: Partial<PushJobOptions> = {}) {
  const now = o.now ?? new Date();
  const plan = assistantPlan(db, now);
  // The list first, so the badge sent with each push already counts what it's about.
  let reported = false;
  try {
    reported = (await recordInbox(db, now, await plan)).reported;
  } catch (e) {
    console.warn('notifications: inbox failed', e);
  }
  const res = await runPushJob(db, {
    ...nitrogenPush(db, plan),
    icon: ICON,
    hour: 0,
    until: 24,
    ...o,
    now,
  });
  // Move the cursor on once the changes were reported (or there were none to wait for), so the
  // next notification only covers what comes after. Held through the night: 8 a.m. reports it.
  try {
    const p = await plan;
    const none = !p.events.some((e) => e.actor?.startsWith('agent:'));
    if (reported || (none && (await anyZoneAwake(db, now))))
      await setSettingStmt(db, CURSOR, now.toISOString()).run();
  } catch (e) {
    console.warn('notifications: cursor failed', e);
  }
  return res;
}

async function anyZoneAwake(db: D1Database, now: Date): Promise<boolean> {
  return (await inboxZones(db)).some((tz) => localClock(now, tz).minutes >= MORNING_HOUR * 60);
}

// ---------------------------------------------------------------------------------------------
// The in-app list (the bell)

/** Notifications older than this are deleted (on every run of the notification job). */
const KEEP_DAYS = 90;

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
export async function recordInbox(
  db: D1Database,
  now: Date,
  plan?: AssistantPlan,
): Promise<{ added: number; reported: boolean }> {
  const items = await loadOpen(db);
  const p = plan ?? (await assistantPlan(db, now));
  const at = now.toISOString();
  const stmts: D1PreparedStatement[] = [];
  let reported = false;
  for (const tz of await inboxZones(db)) {
    const w = windowFor(p, now, tz);
    if (w) reported = true;
    const notices = noticesNow(items, localClock(now, tz), w ? p.events : [], w);
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
  return {
    added: res.slice(0, added).reduce((n, r) => n + (r.meta.changes ?? 0), 0),
    reported,
  };
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
