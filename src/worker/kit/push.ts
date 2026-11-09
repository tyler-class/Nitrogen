// Selfhost Kit: web push notifications and app-icon badges, with nothing to set up.
// Synced from tyler-class/selfhost-kit (kit/worker/push.ts). Edit it there, not here.
//
// - VAPID keys (RFC 8292) are made on first use and kept in the app's D1 (the kit's
//   selfhost_kit table). Nothing to configure, nothing committed.
// - Payloads are encrypted with aes128gcm (RFC 8291), all in WebCrypto.
// - One row per device in selfhost_push_devices: its endpoint and keys, its IANA time zone,
//   and its own choices ({ enabled, <kind>: boolean }). Each family member's phone picks for
//   itself.
// - selfhost_push_sent remembers what went out, keyed by (device, kind, key, local date), so a
//   cron that runs every hour sends each notification at most once.
// - Daily notifications go out on the first run at or after 8:00 in the device's own zone.
//
// Wire-up (see the kit README): mount pushRoutes() behind the app's auth, call runPushJob()
// from the Worker's scheduled handler, and import kit-push-sw.js into the service worker.
import { Hono } from 'hono';

// ---------------------------------------------------------------------------------------------
// Bytes

const encoder = new TextEncoder();
/** UTF-8 bytes (copied into a plain ArrayBuffer, which WebCrypto's types want). */
const utf8 = (s: string) => new Uint8Array(encoder.encode(s));

export function b64url(bytes: ArrayBuffer | Uint8Array): string {
  const arr = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  let s = '';
  for (const x of arr) s += String.fromCharCode(x);
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

export function fromB64url(s: string): Uint8Array<ArrayBuffer> {
  const clean = s.replace(/\s+/g, '').replace(/-/g, '+').replace(/_/g, '/');
  const bin = atob(clean + '==='.slice((clean.length + 3) % 4));
  return Uint8Array.from(bin, (c) => c.charCodeAt(0));
}

function concat(...parts: Uint8Array[]): Uint8Array<ArrayBuffer> {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let at = 0;
  for (const p of parts) {
    out.set(p, at);
    at += p.length;
  }
  return out;
}

/** A P-256 public key's 65 raw bytes (0x04 ‖ x ‖ y) as a JWK. */
function rawToJwk(raw: Uint8Array, d?: Uint8Array): JsonWebKey {
  return {
    kty: 'EC',
    crv: 'P-256',
    x: b64url(raw.slice(1, 33)),
    y: b64url(raw.slice(33, 65)),
    ...(d ? { d: b64url(d) } : {}),
  };
}

// ---------------------------------------------------------------------------------------------
// Tables (made on first use; no migration needed, and none of it is in backups)

const KIT = 'selfhost_kit';
const DEVICES = 'selfhost_push_devices';
const SENT = 'selfhost_push_sent';

const ready = new WeakSet<D1Database>();
async function ensureTables(db: D1Database) {
  if (ready.has(db)) return;
  await db.batch([
    db.prepare(`CREATE TABLE IF NOT EXISTS ${KIT} (key TEXT PRIMARY KEY, value TEXT)`),
    db.prepare(
      `CREATE TABLE IF NOT EXISTS ${DEVICES} (
        id TEXT PRIMARY KEY,
        endpoint TEXT NOT NULL UNIQUE,
        p256dh TEXT NOT NULL,
        auth TEXT NOT NULL,
        tz TEXT NOT NULL DEFAULT 'UTC',
        prefs TEXT NOT NULL DEFAULT '{}',
        label TEXT,
        created_at TEXT NOT NULL,
        last_sent_at TEXT
      )`,
    ),
    db.prepare(
      `CREATE TABLE IF NOT EXISTS ${SENT} (
        device_id TEXT NOT NULL,
        kind TEXT NOT NULL,
        key TEXT NOT NULL,
        date TEXT NOT NULL,
        sent_at TEXT NOT NULL,
        PRIMARY KEY (device_id, kind, key, date)
      )`,
    ),
  ]);
  ready.add(db);
}

// ---------------------------------------------------------------------------------------------
// VAPID (RFC 8292)

export interface VapidKeys {
  /** The application server key: 65 raw bytes, base64url. What the browser subscribes with. */
  publicKey: string;
  privateJwk: JsonWebKey;
}

/** This install's VAPID keys, made the first time they're needed. */
export async function vapidKeys(db: D1Database): Promise<VapidKeys> {
  await ensureTables(db);
  const read = () =>
    db.prepare(`SELECT value FROM ${KIT} WHERE key = 'push_vapid'`).first<string>('value');
  const have = await read();
  if (have) return JSON.parse(have) as VapidKeys;
  const pair = (await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, [
    'sign',
    'verify',
  ])) as CryptoKeyPair;
  const keys: VapidKeys = {
    publicKey: b64url((await crypto.subtle.exportKey('raw', pair.publicKey)) as ArrayBuffer),
    privateJwk: (await crypto.subtle.exportKey('jwk', pair.privateKey)) as JsonWebKey,
  };
  // Two first requests at once: keep whichever pair landed first.
  await db
    .prepare(`INSERT INTO ${KIT} (key, value) VALUES ('push_vapid', ?) ON CONFLICT DO NOTHING`)
    .bind(JSON.stringify(keys))
    .run();
  return JSON.parse((await read()) ?? JSON.stringify(keys)) as VapidKeys;
}

/** The VAPID JWT for a push service origin, valid for 12 hours (Apple allows up to 24). */
export async function vapidJwt(
  keys: VapidKeys,
  audience: string,
  subject: string,
  now = Date.now(),
): Promise<string> {
  const header = b64url(utf8(JSON.stringify({ typ: 'JWT', alg: 'ES256' })));
  const claims = b64url(
    utf8(JSON.stringify({ aud: audience, exp: Math.floor(now / 1000) + 12 * 3600, sub: subject })),
  );
  const key = await crypto.subtle.importKey(
    'jwk',
    keys.privateJwk,
    { name: 'ECDSA', namedCurve: 'P-256' },
    false,
    ['sign'],
  );
  // WebCrypto's ECDSA signature is r ‖ s (64 bytes), which is what JWS ES256 wants.
  const sig = await crypto.subtle.sign(
    { name: 'ECDSA', hash: 'SHA-256' },
    key,
    utf8(`${header}.${claims}`),
  );
  return `${header}.${claims}.${b64url(sig)}`;
}

/** The Authorization header for a push to `endpoint`. */
export async function vapidAuth(
  keys: VapidKeys,
  endpoint: string,
  subject: string,
  now = Date.now(),
): Promise<string> {
  const jwt = await vapidJwt(keys, new URL(endpoint).origin, subject, now);
  return `vapid t=${jwt}, k=${keys.publicKey}`;
}

// ---------------------------------------------------------------------------------------------
// Payload encryption (RFC 8291, aes128gcm from RFC 8188)

async function hkdf(
  salt: Uint8Array<ArrayBuffer>,
  ikm: Uint8Array<ArrayBuffer>,
  info: Uint8Array<ArrayBuffer>,
  bytes: number,
): Promise<Uint8Array<ArrayBuffer>> {
  const key = await crypto.subtle.importKey('raw', ikm, 'HKDF', false, ['deriveBits']);
  return new Uint8Array(
    await crypto.subtle.deriveBits({ name: 'HKDF', hash: 'SHA-256', salt, info }, key, bytes * 8),
  );
}

export interface EncryptOptions {
  /** For tests (RFC 8291 Appendix A): a fixed sender key pair and salt. Random otherwise. */
  senderPrivate?: Uint8Array<ArrayBuffer>;
  senderPublic?: Uint8Array<ArrayBuffer>;
  salt?: Uint8Array<ArrayBuffer>;
}

/** The encrypted push body for a device: header (salt, record size, sender key) ‖ ciphertext. */
export async function encryptPayload(
  plaintext: Uint8Array<ArrayBuffer>,
  p256dh: string,
  authSecret: string,
  o: EncryptOptions = {},
): Promise<Uint8Array<ArrayBuffer>> {
  const uaPublic = fromB64url(p256dh);
  const auth = fromB64url(authSecret);
  if (uaPublic.length !== 65 || uaPublic[0] !== 4) throw new Error('Bad p256dh key');
  if (auth.length !== 16) throw new Error('Bad auth secret');

  let asPrivate: CryptoKey;
  let asPublic: Uint8Array<ArrayBuffer>;
  if (o.senderPrivate && o.senderPublic) {
    asPublic = o.senderPublic;
    asPrivate = await crypto.subtle.importKey(
      'jwk',
      rawToJwk(asPublic, o.senderPrivate),
      { name: 'ECDH', namedCurve: 'P-256' },
      false,
      ['deriveBits'],
    );
  } else {
    const pair = (await crypto.subtle.generateKey({ name: 'ECDH', namedCurve: 'P-256' }, true, [
      'deriveBits',
    ])) as CryptoKeyPair;
    asPrivate = pair.privateKey;
    asPublic = new Uint8Array(
      (await crypto.subtle.exportKey('raw', pair.publicKey)) as ArrayBuffer,
    );
  }
  const uaKey = await crypto.subtle.importKey(
    'raw',
    uaPublic,
    { name: 'ECDH', namedCurve: 'P-256' },
    false,
    [],
  );
  const ecdh = new Uint8Array(
    await crypto.subtle.deriveBits(
      // Workers' types call it $public; the runtime (and the spec) want `public`.
      { name: 'ECDH', public: uaKey } as unknown as Parameters<SubtleCrypto['deriveBits']>[0],
      asPrivate,
      256,
    ),
  );
  const keyInfo = concat(utf8('WebPush: info\0'), uaPublic, asPublic);
  const ikm = await hkdf(auth, ecdh, keyInfo, 32);
  const salt = o.salt ?? new Uint8Array(16);
  if (!o.salt) crypto.getRandomValues(salt);
  const cek = await hkdf(salt, ikm, utf8('Content-Encoding: aes128gcm\0'), 16);
  const nonce = await hkdf(salt, ikm, utf8('Content-Encoding: nonce\0'), 12);

  // One record: the plaintext, then the last-record delimiter 0x02 (no padding).
  const key = await crypto.subtle.importKey('raw', cek, 'AES-GCM', false, ['encrypt']);
  const cipher = new Uint8Array(
    await crypto.subtle.encrypt(
      { name: 'AES-GCM', iv: nonce },
      key,
      concat(plaintext, new Uint8Array([2])),
    ),
  );
  const header = new Uint8Array(16 + 4 + 1);
  header.set(salt, 0);
  new DataView(header.buffer).setUint32(16, 4096);
  header[20] = asPublic.length;
  return concat(header, asPublic, cipher);
}

// ---------------------------------------------------------------------------------------------
// Devices

/** A device's choices: the master switch, and one switch per kind of notification. */
export type PushPrefs = { enabled: boolean } & Record<string, boolean>;

export interface PushDevice {
  id: string;
  endpoint: string;
  p256dh: string;
  auth: string;
  /** IANA time zone, from the device's Intl settings. */
  tz: string;
  prefs: PushPrefs;
  /** "iPhone Safari", for telling devices apart. */
  label: string | null;
  created_at: string;
  last_sent_at: string | null;
}

type DeviceRow = Omit<PushDevice, 'prefs'> & { prefs: string };

function toDevice(r: DeviceRow): PushDevice {
  let prefs: PushPrefs = { enabled: false };
  try {
    prefs = { ...(JSON.parse(r.prefs) as Record<string, boolean>), enabled: false };
    prefs.enabled = (JSON.parse(r.prefs) as { enabled?: unknown }).enabled === true;
  } catch {
    /* keep off */
  }
  return { ...r, prefs };
}

export function isTimeZone(tz: unknown): tz is string {
  if (typeof tz !== 'string' || !tz) return false;
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

/** "iPhone Safari", "Mac Chrome", "Android Chrome". */
export function deviceLabel(ua: string | null | undefined): string | null {
  if (!ua) return null;
  const os = /iPhone/.test(ua)
    ? 'iPhone'
    : /iPad/.test(ua)
      ? 'iPad'
      : /Android/.test(ua)
        ? 'Android'
        : /Macintosh|Mac OS X/.test(ua)
          ? 'Mac'
          : /Windows/.test(ua)
            ? 'Windows'
            : /Linux|CrOS/.test(ua)
              ? 'Linux'
              : null;
  const browser = /Edg\//.test(ua)
    ? 'Edge'
    : /Firefox\/|FxiOS/.test(ua)
      ? 'Firefox'
      : /Chrome\/|CriOS/.test(ua)
        ? 'Chrome'
        : /Safari\//.test(ua)
          ? 'Safari'
          : null;
  return [os, browser].filter(Boolean).join(' ') || null;
}

export async function listDevices(db: D1Database): Promise<PushDevice[]> {
  await ensureTables(db);
  const { results } = await db
    .prepare(`SELECT * FROM ${DEVICES} ORDER BY created_at`)
    .all<DeviceRow>();
  return results.map(toDevice);
}

export async function findDevice(db: D1Database, endpoint: string): Promise<PushDevice | null> {
  await ensureTables(db);
  const r = await db
    .prepare(`SELECT * FROM ${DEVICES} WHERE endpoint = ?`)
    .bind(endpoint)
    .first<DeviceRow>();
  return r ? toDevice(r) : null;
}

export interface SubscribeInput {
  subscription: { endpoint: string; keys: { p256dh: string; auth: string } };
  tz?: string;
  prefs?: Partial<PushPrefs>;
  label?: string | null;
}

/** Adds this device, or updates it (same endpoint): new keys, zone and choices. */
export async function saveDevice(db: D1Database, input: SubscribeInput): Promise<PushDevice> {
  await ensureTables(db);
  const { endpoint, keys } = input.subscription;
  const old = await findDevice(db, endpoint);
  const prefs = { ...(old?.prefs ?? { enabled: true }), ...cleanPrefs(input.prefs) } as PushPrefs;
  const tz = isTimeZone(input.tz) ? input.tz : (old?.tz ?? 'UTC');
  await db
    .prepare(
      `INSERT INTO ${DEVICES} (id, endpoint, p256dh, auth, tz, prefs, label, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT (endpoint) DO UPDATE SET p256dh = excluded.p256dh, auth = excluded.auth,
         tz = excluded.tz, prefs = excluded.prefs, label = COALESCE(excluded.label, label)`,
    )
    .bind(
      crypto.randomUUID(),
      endpoint,
      keys.p256dh,
      keys.auth,
      tz,
      JSON.stringify(prefs),
      input.label ?? null,
      new Date().toISOString(),
    )
    .run();
  return (await findDevice(db, endpoint))!;
}

/** Changes a device's choices and/or zone. Null when the device isn't known. */
export async function updateDevice(
  db: D1Database,
  endpoint: string,
  patch: { prefs?: Partial<PushPrefs>; tz?: string },
): Promise<PushDevice | null> {
  const old = await findDevice(db, endpoint);
  if (!old) return null;
  const prefs = { ...old.prefs, ...cleanPrefs(patch.prefs) } as PushPrefs;
  const tz = isTimeZone(patch.tz) ? patch.tz : old.tz;
  await db
    .prepare(`UPDATE ${DEVICES} SET prefs = ?, tz = ? WHERE id = ?`)
    .bind(JSON.stringify(prefs), tz, old.id)
    .run();
  return { ...old, prefs, tz };
}

export async function removeDevice(db: D1Database, endpoint: string): Promise<void> {
  await ensureTables(db);
  const d = await findDevice(db, endpoint);
  if (!d) return;
  await db.batch([
    db.prepare(`DELETE FROM ${DEVICES} WHERE id = ?`).bind(d.id),
    db.prepare(`DELETE FROM ${SENT} WHERE device_id = ?`).bind(d.id),
  ]);
}

function cleanPrefs(p: unknown): Record<string, boolean> {
  if (!p || typeof p !== 'object') return {};
  return Object.fromEntries(
    Object.entries(p).filter(
      ([k, v]) => typeof v === 'boolean' && /^[a-z][a-z0-9_-]{0,39}$/i.test(k),
    ),
  ) as Record<string, boolean>;
}

/** Whether a device wants a kind of notification (kinds are on unless switched off). */
export const wants = (d: PushDevice, kind: string) => d.prefs.enabled && d.prefs[kind] !== false;

// ---------------------------------------------------------------------------------------------
// Sending

export interface PushMessage {
  title: string;
  body: string;
  /** Opened when the notification is tapped: a same-origin path like "/trips/abc". */
  url: string;
  /** The app-icon badge count to show (0 clears it). Left out: the badge isn't touched. */
  badge?: number;
  /** Replaces an earlier notification with the same tag. */
  tag?: string;
  /** Notification icon path; the service worker falls back to its own default. */
  icon?: string;
}

export interface SendOptions {
  /** VAPID "sub": a mailto: or https: contact. Defaults to the address saved by pushRoutes. */
  subject?: string;
  /** Seconds the push service may hold it while the device is offline. Default one day. */
  ttl?: number;
  urgency?: 'very-low' | 'low' | 'normal' | 'high';
  fetcher?: typeof fetch;
  now?: number;
}

export type SendResult = 'sent' | 'gone' | 'failed';

/** Push payloads must fit in 4 KB once encrypted: keep the words short. */
const clip = (s: string, n: number) => (s.length > n ? `${s.slice(0, n - 1).trimEnd()}…` : s);

async function subject(db: D1Database): Promise<string> {
  const s = await db
    .prepare(`SELECT value FROM ${KIT} WHERE key = 'push_subject'`)
    .first<string>('value');
  return s ?? 'mailto:selfhost@tylerclass.net';
}

/**
 * Encrypts and sends one notification. A device the push service says is gone (404/410) is
 * removed. Never throws.
 */
export async function sendPush(
  db: D1Database,
  device: Pick<PushDevice, 'id' | 'endpoint' | 'p256dh' | 'auth'>,
  msg: PushMessage,
  o: SendOptions = {},
): Promise<SendResult> {
  try {
    await ensureTables(db);
    const keys = await vapidKeys(db);
    const payload = utf8(
      JSON.stringify({ ...msg, title: clip(msg.title, 120), body: clip(msg.body, 600) }),
    );
    const body = await encryptPayload(payload, device.p256dh, device.auth);
    const res = await (o.fetcher ?? fetch)(device.endpoint, {
      method: 'POST',
      headers: {
        Authorization: await vapidAuth(
          keys,
          device.endpoint,
          o.subject ?? (await subject(db)),
          o.now,
        ),
        'Content-Encoding': 'aes128gcm',
        'Content-Type': 'application/octet-stream',
        TTL: String(o.ttl ?? 86_400),
        Urgency: o.urgency ?? 'normal',
        ...(msg.tag ? { Topic: msg.tag.replace(/[^A-Za-z0-9_-]/g, '').slice(0, 32) } : {}),
      },
      body,
    });
    if (res.status === 404 || res.status === 410) {
      await removeDevice(db, device.endpoint);
      return 'gone';
    }
    if (!res.ok) {
      console.warn(`push: ${res.status} from ${new URL(device.endpoint).host}`);
      return 'failed';
    }
    await db
      .prepare(`UPDATE ${DEVICES} SET last_sent_at = ? WHERE id = ?`)
      .bind(new Date(o.now ?? Date.now()).toISOString(), device.id)
      .run();
    return 'sent';
  } catch (e) {
    console.warn('push: send failed', e);
    return 'failed';
  }
}

// ---------------------------------------------------------------------------------------------
// Time in a device's zone

const fmts = new Map<string, Intl.DateTimeFormat>();
function parts(at: Date, tz: string) {
  let f = fmts.get(tz);
  if (!f) {
    f = new Intl.DateTimeFormat('en-US', {
      timeZone: isTimeZone(tz) ? tz : 'UTC',
      hourCycle: 'h23',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
    });
    fmts.set(tz, f);
  }
  const p = Object.fromEntries(f.formatToParts(at).map((x) => [x.type, x.value]));
  return { date: `${p.year}-${p.month}-${p.day}`, hour: Number(p.hour) % 24 };
}

/** The date ("2027-06-03") in a time zone at an instant. */
export const localDate = (at: Date, tz: string) => parts(at, tz).date;

/** The hour (0–23) in a time zone at an instant. */
export const localHour = (at: Date, tz: string) => parts(at, tz).hour;

/** Whether it's at or after `hour`:00 (and before `until`:00, if given) in a time zone. */
export function atOrAfterLocalHour(at: Date, tz: string, hour: number, until = 24): boolean {
  const h = localHour(at, tz);
  return h >= hour && h < until;
}

// ---------------------------------------------------------------------------------------------
// The notification job (call from the Worker's scheduled handler)

/** One notification a device could get now. */
export interface PushCandidate {
  /** The kind (its switch in Settings), like "todos". */
  kind: string;
  /** What it's about, so it's sent once per day per thing: a trip id, or "today". */
  key: string;
  /** Whose clock decides 8 a.m. and "today". Default: the device's zone. */
  tz?: string;
  message: PushMessage;
}

export interface PushJobOptions {
  /**
   * The app's notifications for a device right now. Work out "today" with
   * localDate(now, device.tz) (or a trip's own zone, given back as `tz`).
   */
  build(device: PushDevice, now: Date): Promise<PushCandidate[]> | PushCandidate[];
  /** The app-icon count for a device, added to every notification. Leave out for no badge. */
  badge?(device: PushDevice, now: Date, db: D1Database): Promise<number> | number;
  /** Send from this hour, local time (default 8)… */
  hour?: number;
  /** …until this hour (default 21: nothing late at night if the cron was down all day). */
  until?: number;
  icon?: string;
  now?: Date;
  fetcher?: typeof fetch;
}

export interface PushJobResult {
  sent: number;
  failed: number;
  gone: number;
}

/**
 * Sends what's due: for each device that's on, each notification it wants, on the first run at
 * or after 8:00 in its zone, at most once a day (the sent log). A failed send is tried again
 * on the next run. Never throws.
 */
export async function runPushJob(db: D1Database, o: PushJobOptions): Promise<PushJobResult> {
  const out: PushJobResult = { sent: 0, failed: 0, gone: 0 };
  try {
    const now = o.now ?? new Date();
    const hour = o.hour ?? 8;
    const until = o.until ?? 21;
    for (const device of await listDevices(db)) {
      if (!device.prefs.enabled) continue;
      let due: PushCandidate[];
      try {
        due = (await o.build(device, now)).filter(
          (c) => wants(device, c.kind) && atOrAfterLocalHour(now, c.tz ?? device.tz, hour, until),
        );
      } catch (e) {
        console.warn('push: build failed', e);
        continue;
      }
      if (!due.length) continue;
      const badge = o.badge ? await o.badge(device, now, db) : undefined;
      for (const c of due) {
        const date = localDate(now, c.tz ?? device.tz);
        // Claim it first, so two overlapping runs can't both send.
        const claim = await db
          .prepare(
            `INSERT INTO ${SENT} (device_id, kind, key, date, sent_at) VALUES (?, ?, ?, ?, ?)
             ON CONFLICT DO NOTHING`,
          )
          .bind(device.id, c.kind, c.key, date, now.toISOString())
          .run();
        if (!claim.meta.changes) continue;
        const r = await sendPush(
          db,
          device,
          { icon: o.icon, ...c.message, ...(badge !== undefined ? { badge } : {}) },
          { fetcher: o.fetcher, now: now.getTime() },
        );
        if (r === 'gone') {
          out.gone++;
          break;
        }
        if (r === 'failed') {
          out.failed++;
          await db
            .prepare(
              `DELETE FROM ${SENT} WHERE device_id = ? AND kind = ? AND key = ? AND date = ?`,
            )
            .bind(device.id, c.kind, c.key, date)
            .run();
          continue;
        }
        out.sent++;
      }
    }
    // The log only needs recent days.
    const cutoff = new Date(now.getTime() - 60 * 86_400_000).toISOString().slice(0, 10);
    await db.prepare(`DELETE FROM ${SENT} WHERE date < ?`).bind(cutoff).run();
  } catch (e) {
    console.warn('push: job failed', e);
  }
  return out;
}

// ---------------------------------------------------------------------------------------------
// API routes (mount behind the app's auth: app.route('/', pushRoutes({ ... })))

export interface PushRoutesOptions {
  /** The app's name, for the test notification ("Duffel notifications are on"). */
  title: string;
  /** The kinds this app sends (their ids). New devices get each one switched on. */
  kinds: string[];
  /** The app-icon count for a device (see PushJobOptions.badge). */
  badge?(device: PushDevice, now: Date, db: D1Database): Promise<number> | number;
  /** Where the test notification opens. Default /settings. */
  testUrl?: string;
  icon?: string;
  /** VAPID contact when the app isn't on https (local dev). */
  fallbackSubject?: string;
  /** For tests. */
  fetcher?: typeof fetch;
}

type PushEnv = { Bindings: { DB: D1Database } };

class Bad extends Error {}

function str(v: unknown, what: string, max = 2048): string {
  if (typeof v !== 'string' || !v || v.length > max) throw new Bad(`Missing or bad ${what}.`);
  return v;
}

function endpointOf(v: unknown): string {
  const e = str(v, 'endpoint');
  let u: URL;
  try {
    u = new URL(e);
  } catch {
    throw new Bad('Missing or bad endpoint.');
  }
  if (u.protocol !== 'https:') throw new Bad('The endpoint must be https.');
  return e;
}

/**
 * The push API, under /push (so /api/push/... when the app's router has basePath('/api')):
 *   GET    /push/key           → { key }                  the VAPID public key
 *   POST   /push/device        { endpoint } → { device }  this device's choices (null if new)
 *   POST   /push/subscribe     { subscription, tz, prefs } → { device }
 *   PATCH  /push/prefs         { endpoint, prefs?, tz? } → { device }
 *   POST   /push/unsubscribe   { endpoint } → { ok }
 *   POST   /push/test          { endpoint } → { result }  a test notification to this device
 *   POST   /push/badge         { endpoint } → { count }   the app-icon count for this device
 */
export function pushRoutes(o: PushRoutesOptions) {
  const r = new Hono<PushEnv>();
  const json = async (c: { req: { json(): Promise<unknown> } }) =>
    ((await c.req.json().catch(() => null)) ?? {}) as Record<string, unknown>;
  const view = (d: PushDevice | null) =>
    d && { tz: d.tz, prefs: d.prefs, label: d.label, created_at: d.created_at };

  r.onError((err, c) => {
    if (err instanceof Bad) return c.json({ error: 'invalid', message: err.message }, 400);
    throw err;
  });

  r.get('/push/key', async (c) => c.json({ key: (await vapidKeys(c.env.DB)).publicKey }));

  r.post('/push/device', async (c) => {
    const b = await json(c);
    return c.json({ device: view(await findDevice(c.env.DB, endpointOf(b.endpoint))) });
  });

  r.post('/push/subscribe', async (c) => {
    const b = await json(c);
    const s = (b.subscription ?? {}) as { endpoint?: unknown; keys?: Record<string, unknown> };
    const p256dh = str(s.keys?.p256dh, 'p256dh key', 200);
    const auth = str(s.keys?.auth, 'auth secret', 100);
    if (fromB64url(p256dh).length !== 65 || fromB64url(auth).length !== 16)
      throw new Bad('Missing or bad subscription keys.');
    const db = c.env.DB;
    await ensureTables(db); // a fresh copy may subscribe before anything else created them
    // The VAPID contact: this copy's own address, when it's on https.
    const origin = new URL(c.req.url);
    if (origin.protocol === 'https:' || !(await subjectSet(db)))
      await db
        .prepare(
          `INSERT INTO ${KIT} (key, value) VALUES ('push_subject', ?)
           ON CONFLICT (key) DO UPDATE SET value = excluded.value`,
        )
        .bind(
          origin.protocol === 'https:'
            ? origin.origin
            : (o.fallbackSubject ?? 'mailto:selfhost@tylerclass.net'),
        )
        .run();
    const defaults = Object.fromEntries(o.kinds.map((k) => [k, true]));
    const existing = await findDevice(db, endpointOf(s.endpoint));
    const device = await saveDevice(db, {
      subscription: { endpoint: endpointOf(s.endpoint), keys: { p256dh, auth } },
      tz: typeof b.tz === 'string' ? b.tz : undefined,
      prefs: {
        ...(existing ? {} : defaults),
        enabled: true,
        ...cleanPrefs(b.prefs),
      },
      label: deviceLabel(c.req.header('User-Agent')),
    });
    return c.json({ device: view(device) });
  });

  r.patch('/push/prefs', async (c) => {
    const b = await json(c);
    const d = await updateDevice(c.env.DB, endpointOf(b.endpoint), {
      prefs: cleanPrefs(b.prefs),
      tz: typeof b.tz === 'string' ? b.tz : undefined,
    });
    if (!d)
      return c.json(
        { error: 'not_found', message: 'This device isn’t signed up for notifications.' },
        404,
      );
    return c.json({ device: view(d) });
  });

  r.post('/push/unsubscribe', async (c) => {
    const b = await json(c);
    await removeDevice(c.env.DB, endpointOf(b.endpoint));
    return c.json({ ok: true });
  });

  r.post('/push/test', async (c) => {
    const b = await json(c);
    const db = c.env.DB;
    const d = await findDevice(db, endpointOf(b.endpoint));
    if (!d)
      return c.json(
        { error: 'not_found', message: 'This device isn’t signed up for notifications.' },
        404,
      );
    const badge = o.badge && d.prefs.enabled ? await o.badge(d, new Date(), db) : undefined;
    const result = await sendPush(
      db,
      d,
      {
        title: `${o.title} notifications are on`,
        body: 'This is how they’ll look on this device.',
        url: o.testUrl ?? '/settings',
        tag: 'kit-test',
        icon: o.icon,
        ...(badge !== undefined ? { badge } : {}),
      },
      { fetcher: o.fetcher, urgency: 'high', ttl: 600 },
    );
    if (result !== 'sent')
      return c.json(
        {
          error: result,
          message:
            result === 'gone'
              ? 'This device’s subscription has expired. Turn notifications off and on again.'
              : 'The push service didn’t accept it. Try again in a minute.',
        },
        502,
      );
    return c.json({ result });
  });

  r.post('/push/badge', async (c) => {
    const b = await json(c);
    const d = await findDevice(c.env.DB, endpointOf(b.endpoint));
    const count = d && d.prefs.enabled && o.badge ? await o.badge(d, new Date(), c.env.DB) : 0;
    return c.json({ count });
  });

  return r;
}

async function subjectSet(db: D1Database) {
  return !!(await db.prepare(`SELECT 1 AS x FROM ${KIT} WHERE key = 'push_subject'`).first('x'));
}
