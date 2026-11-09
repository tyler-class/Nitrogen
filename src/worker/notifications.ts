// Nitrogen's notifications on top of the Selfhost Kit's push (src/worker/kit/push.ts): the morning
// digest a device gets, and the app-icon count. The words and rules are in src/shared/notify.ts.
import {
  badgeCount,
  DATED_TYPES,
  digestNotice,
  NOTIFY_KINDS,
  type DatedItem,
  type Notice,
} from '@shared/notify';
import { all } from './db';
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

/** Open dated to-dos and reminders from the items index. */
async function loadDated(db: D1Database): Promise<DatedItem[]> {
  await ensureItemsIndexed(db);
  const rows = await all<Omit<DatedItem, 'done'>>(
    db,
    `SELECT i.page_id, p.title AS page_title, i.line, i.type, i.text, i.due
     FROM page_items i JOIN pages p ON p.id = i.page_id
     WHERE i.done = 0 AND i.due IS NOT NULL AND i.type IN (${DATED_TYPES.map(() => '?').join(', ')})`,
    ...DATED_TYPES,
  );
  return rows.map((r) => ({ ...r, done: false }));
}

const candidate = (n: Notice): PushCandidate => ({
  kind: n.kind,
  key: n.key,
  message: { title: n.title, body: n.body, url: n.url, tag: n.tag },
});

/** The notifications a device could get now, and its badge count. Items load once per run. */
export function nitrogenPush(db: D1Database): Pick<PushJobOptions, 'build' | 'badge'> {
  let items: Promise<DatedItem[]> | null = null;
  const load = () => (items ??= loadDated(db));
  return {
    async build(device: PushDevice, now: Date) {
      const n = digestNotice(await load(), localDate(now, device.tz));
      return n ? [candidate(n)] : [];
    },
    async badge(device: PushDevice, now: Date) {
      return badgeCount(await load(), localDate(now, device.tz));
    },
  };
}

/**
 * The cron's notification run (every 15 minutes; the kit sends each at most once a day). Anything
 * due that hasn't gone out yet is sent at any hour from 8:00 local to midnight (no 21:00 cutoff):
 * a device turned on late in the evening still gets today's.
 */
export function runNotifications(db: D1Database, o: Partial<PushJobOptions> = {}) {
  return runPushJob(db, { ...nitrogenPush(db), icon: ICON, until: 24, ...o });
}

/** /api/push/*: behind Nitrogen's sign-in (mounted after the guard in app.ts). */
export const push = pushRoutes({
  title: 'Nitrogen',
  kinds: NOTIFY_KINDS.map((k) => k.id),
  icon: ICON,
  fallbackSubject: 'mailto:nitrogen@tylerclass.net',
  badge: (device, now, db) => nitrogenPush(db).badge!(device, now, db),
});
