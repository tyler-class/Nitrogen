// Selfhost Kit: anonymous usage check-ins and the kit's own small state table.
// Synced from tyler-class/selfhost-kit (kit/worker/telemetry.ts). Edit it there, not here.
//
// Once a day an install sends: the app's name, a random id it made for itself, its version,
// how many rows each listed table has, how many files its R2 buckets hold (one total), and a
// few true/false flags. Never contents, names or
// anything typed in. Owners can switch it off in Settings (setKitState({ telemetry: false })).
// Switching it off sends one last message saying so (app, id, version, "telemetry_off", time),
// then nothing; switching it back on sends "telemetry_on" and the daily check-in resumes.
//
// Only a live copy sends anything: a real build (never tests) that has served a request at a
// real, non-local address (checkInOnRequest notes it). Local dev, even its cron, never sends.

export const KIT_VERSION = 1;
export const STATS_ORIGIN = 'https://tally.tylerclass.net';
export const CHECKIN_URL = `${STATS_ORIGIN}/v1/checkin`;
export const EVENT_URL = `${STATS_ORIGIN}/v1/event`;

const TABLE = 'selfhost_kit';

// The UTC day this Worker instance last saw a check-in done (or switched off), so requests
// after that cost nothing: no database read until the day changes.
let doneDay: string | null = null;
// The site this Worker instance has already noted (origin, app, version).
let notedSite: string | null = null;

export interface KitState {
  /** A random id for this install, made on first use. */
  install_id: string;
  /** Send the daily check-in. On unless the owner turns it off. */
  telemetry: boolean;
  /** Someone added the update workflow to this copy's GitHub repo, from Settings → Updates. */
  updates_set_up: boolean;
  /** UTC day of the last check-in sent, YYYY-MM-DD. */
  last_checkin: string | null;
  /** Where this copy is live, once a real build has served a request there (null: never). */
  site: KitSite | null;
}

/** A live copy: its public origin, and the app and version that last served a request there. */
export interface KitSite {
  origin: string;
  app: string;
  version: string;
}

function parseSite(v: string | undefined): KitSite | null {
  if (!v) return null;
  try {
    const s = JSON.parse(v) as Partial<KitSite>;
    return typeof s.origin === 'string' &&
      typeof s.app === 'string' &&
      typeof s.version === 'string'
      ? { origin: s.origin, app: s.app, version: s.version }
      : null;
  } catch {
    return null;
  }
}

async function ensureTable(db: D1Database) {
  await db.prepare(`CREATE TABLE IF NOT EXISTS ${TABLE} (key TEXT PRIMARY KEY, value TEXT)`).run();
}

/** The kit's settings for this install (made on first call). */
export async function kitState(db: D1Database): Promise<KitState> {
  await ensureTable(db);
  const { results } = await db
    .prepare(`SELECT key, value FROM ${TABLE}`)
    .all<{ key: string; value: string }>();
  const m = new Map(results.map((r) => [r.key, r.value]));
  let id = m.get('install_id');
  if (!id) {
    id = crypto.randomUUID();
    // Two first requests at once: keep whichever id landed first.
    await db
      .prepare(`INSERT INTO ${TABLE} (key, value) VALUES ('install_id', ?) ON CONFLICT DO NOTHING`)
      .bind(id)
      .run();
    id =
      (await db
        .prepare(`SELECT value FROM ${TABLE} WHERE key = 'install_id'`)
        .first<string>('value')) ?? id;
  }
  return {
    install_id: id,
    telemetry: m.get('telemetry') !== '0',
    updates_set_up: m.get('updates_set_up') === '1',
    last_checkin: m.get('last_checkin') ?? null,
    site: parseSite(m.get('site')),
  };
}

/** Where a live copy is: written by checkInOnRequest (only for real builds at non-local hosts). */
export async function noteSite(db: D1Database, site: KitSite): Promise<void> {
  await ensureTable(db);
  await db
    .prepare(
      `INSERT INTO ${TABLE} (key, value) VALUES ('site', ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value`,
    )
    .bind(JSON.stringify(site))
    .run();
}

export interface SetKitStateOptions {
  now?: Date;
  /** For tests. */
  fetcher?: typeof fetch;
}

/**
 * Changes the kit's settings. Switching telemetry off (or back on) on a live copy also sends
 * Tally one small message saying so: app, install id, version, the event and the time. Never
 * throws because of that message.
 */
export async function setKitState(
  db: D1Database,
  patch: Partial<Pick<KitState, 'telemetry' | 'updates_set_up'>> & { last_checkin?: string },
  o: SetKitStateOptions = {},
) {
  const before = patch.telemetry === undefined ? null : await kitState(db);
  await ensureTable(db);
  const put = (k: string, v: string) =>
    db
      .prepare(
        `INSERT INTO ${TABLE} (key, value) VALUES (?, ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value`,
      )
      .bind(k, v);
  const stmts = [];
  if (patch.telemetry !== undefined) stmts.push(put('telemetry', patch.telemetry ? '1' : '0'));
  if (patch.updates_set_up !== undefined)
    stmts.push(put('updates_set_up', patch.updates_set_up ? '1' : '0'));
  if (patch.last_checkin !== undefined) stmts.push(put('last_checkin', patch.last_checkin));
  if (stmts.length) await db.batch(stmts);
  if (before && patch.telemetry !== before.telemetry) {
    if (patch.telemetry) doneDay = null; // the daily check-in resumes on the next request
    await sendEvent(before, patch.telemetry ? 'telemetry_on' : 'telemetry_off', o);
  }
}

export type TelemetryEvent = 'telemetry_off' | 'telemetry_on';

/** The on/off message, from a live copy only. 'skipped' anywhere else (tests, local dev). */
export async function sendEvent(
  s: KitState,
  event: TelemetryEvent,
  o: SetKitStateOptions = {},
): Promise<'sent' | 'skipped' | 'failed'> {
  if (!s.site) return 'skipped';
  try {
    const res = await (o.fetcher ?? fetch)(EVENT_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        app: s.site.app,
        install: s.install_id,
        version: s.site.version,
        event,
        at: (o.now ?? new Date()).toISOString(),
      }),
      signal: AbortSignal.timeout(5000),
    });
    return res.ok ? 'sent' : 'failed';
  } catch {
    return 'failed';
  }
}

/** How many files the buckets hold in all. Stops counting at `cap` (a big bucket is "lots"). */
export async function fileCount(buckets: R2Bucket[], cap = 100_000): Promise<number> {
  let n = 0;
  for (const b of buckets) {
    let cursor: string | undefined;
    do {
      const page = await b.list({ limit: 1000, cursor });
      n += page.objects.length;
      cursor = page.truncated ? page.cursor : undefined;
    } while (cursor && n < cap);
    if (n >= cap) return cap;
  }
  return n;
}

/** How many rows each table has. Names must be plain table names. */
export async function rowCounts(db: D1Database, tables: string[]): Promise<Record<string, number>> {
  const safe = tables.filter((t) => /^[a-z_][a-z0-9_]*$/i.test(t));
  if (!safe.length) return {};
  const sql = `SELECT ${safe.map((t) => `(SELECT COUNT(*) FROM "${t}") AS "${t}"`).join(', ')}`;
  const r = await db.prepare(sql).first<Record<string, number>>();
  return Object.fromEntries(safe.map((t) => [t, Number(r?.[t] ?? 0)]));
}

export interface CheckInOptions {
  /** "duffel", "hsa-locker", "ratio", "nitrogen". */
  app: string;
  version: string;
  /** Tables whose row counts stand in for how much the app is used. */
  tables: string[];
  /** R2 buckets whose files are counted (one total). Leave out if the app has none. */
  buckets?: R2Bucket[];
  /**
   * What the build saw (kit buildFlags()): whether the copy's repo has the update workflow,
   * and whether this is the app's own source repo. Without it, the Settings click is used.
   */
  build?: { updatesOn: boolean; source: boolean; real?: boolean };
  /** Extra true/false facts (updates_set_up and source are added for you). */
  flags?: Record<string, boolean>;
  now?: Date;
  /** For tests. */
  fetcher?: typeof fetch;
}

/**
 * Sends today's check-in, at most once a UTC day. Call it from the Worker's scheduled
 * handler (any cron works; it only sends once a day). Never throws.
 *
 * 'not-live': nothing sent, because this isn't a real build (tests) or the copy hasn't yet
 * served a request at a real, non-local address (local dev, whose cron must never send).
 */
export async function checkIn(
  db: D1Database,
  o: CheckInOptions,
): Promise<'sent' | 'off' | 'already' | 'failed' | 'not-live'> {
  try {
    if (!o.build?.real) return 'not-live';
    const s = await kitState(db);
    if (!s.site) return 'not-live';
    if (!s.telemetry) return 'off';
    const day = (o.now ?? new Date()).toISOString().slice(0, 10);
    if (s.last_checkin === day) return 'already';
    const res = await (o.fetcher ?? fetch)(CHECKIN_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        app: o.app,
        install: s.install_id,
        version: o.version,
        rows: await rowCounts(db, o.tables),
        ...(o.buckets?.length ? { files: await fileCount(o.buckets) } : {}),
        flags: {
          ...o.flags,
          updates_set_up: o.build ? o.build.updatesOn : s.updates_set_up,
          ...(o.build ? { source: o.build.source } : {}),
        },
        kit: KIT_VERSION,
      }),
    });
    if (!res.ok) return 'failed';
    await setKitState(db, { last_checkin: day });
    return 'sent';
  } catch {
    return 'failed';
  }
}

/** localhost, *.local, *.test, *.localhost and private network addresses. */
export const isLocal = (host: string) =>
  /^(localhost|127\.|\[?::1\]?$|10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.)/.test(host) ||
  /\.(local|test|localhost)$/.test(host);

/**
 * The same daily check-in, from a request: call it at the top of the Worker's fetch handler
 * (`checkInOnRequest(ctx, request, env.DB, opts)`), so a copy that's opened checks in that day even
 * before its cron runs. At most once a day per copy, like the cron; never slows the request.
 */
export function checkInOnRequest(
  ctx: { waitUntil(p: Promise<unknown>): void },
  request: Request,
  db: D1Database,
  o: CheckInOptions,
): void {
  // Only real copies on the internet: never tests (no real build) or local dev.
  const url = new URL(request.url);
  if (!o.build?.real || isLocal(url.hostname)) return;
  const site: KitSite = { origin: url.origin, app: o.app, version: o.version };
  const siteKey = JSON.stringify(site);
  const day = (o.now ?? new Date()).toISOString().slice(0, 10);
  const note = notedSite !== siteKey;
  const send = doneDay !== day;
  if (!note && !send) return;
  notedSite = siteKey;
  if (send) doneDay = day; // claim it now, so a burst of requests sends once
  ctx.waitUntil(
    (async () => {
      try {
        // Marks this copy live, so the cron may check in too (and keeps app and version current
        // for the on/off message).
        if (note && JSON.stringify((await kitState(db)).site) !== siteKey) await noteSite(db, site);
      } catch {
        notedSite = null; // note it on a later request
      }
      if (!send) return;
      const r = await checkIn(db, o);
      if (r === 'failed' || r === 'not-live') doneDay = null; // try again on a later request
    })(),
  );
}

/** For tests: forget what this Worker instance remembers between requests. */
export function resetTelemetryMemo() {
  doneDay = null;
  notedSite = null;
}
