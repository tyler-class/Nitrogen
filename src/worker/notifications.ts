// Nitrogen's notifications on top of the Selfhost Kit's push (src/worker/kit/push.ts): what a
// device gets, and the app-icon count. This file only loads data; which notifications are due and
// what they say are pure functions in src/shared/notify.ts.
import {
  assistantWindow,
  badgeCount,
  DATED_TYPES,
  localClock,
  noticesNow,
  NOTIFY_KINDS,
  type AssistantEvent,
  type AssistantWindow,
  type DatedItem,
  type Notice,
} from '@shared/notify';
import { all, first } from './db';
import { ensureItemsIndexed } from './sessions';
import {
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
    async badge(device: PushDevice, now: Date) {
      return badgeCount(await load(), localDate(now, device.tz));
    },
  };
}

/**
 * The cron's notification run (every 15 minutes). The kit's own 8 a.m. gate is opened all day
 * (hour 0): noticesNow decides the time for each kind (8 a.m. for the morning ones, an item's
 * own time for timed ones, hourly for assistant changes). Morning ones not yet sent still go out
 * at any hour until midnight, so a device turned on late in the evening gets today's.
 */
export function runNotifications(db: D1Database, o: Partial<PushJobOptions> = {}) {
  return runPushJob(db, { ...nitrogenPush(db), icon: ICON, hour: 0, until: 24, ...o });
}

/** /api/push/*: behind Nitrogen's sign-in (mounted after the guard in app.ts). */
export const push = pushRoutes({
  title: 'Nitrogen',
  kinds: NOTIFY_KINDS.map((k) => k.id),
  icon: ICON,
  fallbackSubject: 'mailto:nitrogen@tylerclass.net',
  badge: (device, now, db) => nitrogenPush(db).badge!(device, now, db),
});
