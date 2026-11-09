// Selfhost Kit: anonymous usage check-ins and the kit's own small state table.
// Synced from tyler-class/selfhost-kit (kit/worker/telemetry.ts). Edit it there, not here.
//
// Once a day an install sends: the app's name, a random id it made for itself, its version,
// how many rows each listed table has, how many files its R2 buckets hold (one total), and a
// few true/false flags. Never contents, names or
// anything typed in. Owners can switch it off in Settings (setKitState({ telemetry: false })).

export const KIT_VERSION = 1;
export const CHECKIN_URL = 'https://stats.tylerclass.net/v1/checkin';

const TABLE = 'selfhost_kit';

export interface KitState {
  /** A random id for this install, made on first use. */
  install_id: string;
  /** Send the daily check-in. On unless the owner turns it off. */
  telemetry: boolean;
  /** Someone added the update workflow to this copy's GitHub repo, from Settings → Updates. */
  updates_set_up: boolean;
  /** UTC day of the last check-in sent, YYYY-MM-DD. */
  last_checkin: string | null;
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
  };
}

/** Changes the kit's settings. */
export async function setKitState(
  db: D1Database,
  patch: Partial<Pick<KitState, 'telemetry' | 'updates_set_up'>> & { last_checkin?: string },
) {
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
 */
export async function checkIn(
  db: D1Database,
  o: CheckInOptions,
): Promise<'sent' | 'off' | 'already' | 'failed'> {
  try {
    const s = await kitState(db);
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

// The UTC day this Worker instance last saw a check-in done (or switched off), so requests
// after that cost nothing: no database read until the day changes.
let doneDay: string | null = null;

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
  if (!o.build?.real || isLocal(new URL(request.url).hostname)) return;
  const day = (o.now ?? new Date()).toISOString().slice(0, 10);
  if (doneDay === day) return;
  doneDay = day; // claim it now, so a burst of requests sends once
  ctx.waitUntil(
    checkIn(db, o).then((r) => {
      if (r === 'failed') doneDay = null; // try again on a later request
    }),
  );
}
