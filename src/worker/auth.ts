// Single shared password per instance. Sessions are signed with a key derived
// from APP_PASSWORD + a random per-instance salt, so changing the password
// signs everyone out.
import type { Context, MiddlewareHandler } from 'hono';
import { agent, YOU, type Actor } from '@shared/actor';
import { getCookie, setCookie, deleteCookie } from 'hono/cookie';
import { first, nowIso } from './db';

export const COOKIE = 'n2_session';
export const SESSION_DAYS = 90;
export const MAX_FAILURES = 10;
export const WINDOW_MINUTES = 15;

type Env = { Bindings: Cloudflare.Env };
const enc = new TextEncoder();

function b64url(bytes: ArrayBuffer | Uint8Array): string {
  const arr = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  let s = '';
  for (const x of arr) s += String.fromCharCode(x);
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function fromB64url(s: string): Uint8Array {
  const pad = s.replace(/-/g, '+').replace(/_/g, '/') + '==='.slice((s.length + 3) % 4);
  const bin = atob(pad);
  return Uint8Array.from(bin, (c) => c.charCodeAt(0));
}

async function sha256(s: string): Promise<ArrayBuffer> {
  return crypto.subtle.digest('SHA-256', enc.encode(s));
}

export async function passwordMatches(input: string, expected: string): Promise<boolean> {
  const [a, b] = await Promise.all([sha256(input), sha256(expected)]);
  return crypto.subtle.timingSafeEqual(a, b);
}

export async function getSalt(db: D1Database): Promise<string> {
  const existing = await first<{ value: string }>(
    db,
    "SELECT value FROM settings WHERE key = 'session_salt'",
  );
  if (existing) return existing.value;
  const salt = b64url(crypto.getRandomValues(new Uint8Array(32)));
  await db
    .prepare("INSERT OR IGNORE INTO settings (key, value) VALUES ('session_salt', ?)")
    .bind(salt)
    .run();
  return (await first<{ value: string }>(
    db,
    "SELECT value FROM settings WHERE key = 'session_salt'",
  ))!.value;
}

async function signingKey(password: string, salt: string): Promise<CryptoKey> {
  const material = await sha256(`nitrogen-session:${salt}:${password}`);
  return crypto.subtle.importKey('raw', material, { name: 'HMAC', hash: 'SHA-256' }, false, [
    'sign',
    'verify',
  ]);
}

export async function makeToken(password: string, salt: string, now = Date.now()): Promise<string> {
  const payload = b64url(
    enc.encode(JSON.stringify({ iat: now, exp: now + SESSION_DAYS * 86_400_000 })),
  );
  const sig = await crypto.subtle.sign(
    'HMAC',
    await signingKey(password, salt),
    enc.encode(payload),
  );
  return `${payload}.${b64url(sig)}`;
}

export async function verifyToken(
  token: string,
  password: string,
  salt: string,
  now = Date.now(),
): Promise<boolean> {
  const [payload, sig] = token.split('.');
  if (!payload || !sig) return false;
  try {
    const ok = await crypto.subtle.verify(
      'HMAC',
      await signingKey(password, salt),
      fromB64url(sig),
      enc.encode(payload),
    );
    if (!ok) return false;
    const { exp } = JSON.parse(new TextDecoder().decode(fromB64url(payload))) as { exp: number };
    return typeof exp === 'number' && exp > now;
  } catch {
    return false;
  }
}

export function clientIp(c: Context): string {
  return c.req.header('CF-Connecting-IP') ?? 'unknown';
}

export async function tooManyFailures(db: D1Database, ip: string): Promise<boolean> {
  const since = new Date(Date.now() - WINDOW_MINUTES * 60_000).toISOString();
  const row = await first<{ n: number }>(
    db,
    'SELECT COUNT(*) AS n FROM login_attempts WHERE ip = ? AND attempted_at > ?',
    ip,
    since,
  );
  return (row?.n ?? 0) >= MAX_FAILURES;
}

export async function recordFailure(db: D1Database, ip: string): Promise<void> {
  const cutoff = new Date(Date.now() - 24 * 3_600_000).toISOString();
  await db.batch([
    db.prepare('INSERT INTO login_attempts (ip, attempted_at) VALUES (?, ?)').bind(ip, nowIso()),
    db.prepare('DELETE FROM login_attempts WHERE attempted_at < ?').bind(cutoff),
  ]);
}

export async function clearFailures(db: D1Database, ip: string): Promise<void> {
  await db.prepare('DELETE FROM login_attempts WHERE ip = ?').bind(ip).run();
}

export function setSessionCookie(c: Context, token: string) {
  setCookie(c, COOKIE, token, {
    httpOnly: true,
    // Always HTTPS in production; plain http only happens in local dev (e.g. a phone on the LAN).
    secure: new URL(c.req.url).protocol === 'https:',
    sameSite: 'Lax',
    path: '/',
    maxAge: SESSION_DAYS * 86_400,
  });
}

export function clearSessionCookie(c: Context) {
  deleteCookie(c, COOKIE, { path: '/', secure: new URL(c.req.url).protocol === 'https:' });
}

export async function isSignedIn(c: Context<Env>): Promise<boolean> {
  const token = getCookie(c, COOKIE);
  const pw = c.env.APP_PASSWORD;
  if (!token || !pw) return false;
  return verifyToken(token, pw, await getSalt(c.env.DB));
}

/** Session check for routes outside the Hono app (images under /files/*). */
export async function requestSignedIn(request: Request, env: Cloudflare.Env): Promise<boolean> {
  const pw = env.APP_PASSWORD;
  if (!pw) return false;
  const cookie = (request.headers.get('Cookie') ?? '')
    .split(';')
    .map((s) => s.trim())
    .find((s) => s.startsWith(`${COOKIE}=`));
  if (!cookie) return false;
  return verifyToken(cookie.slice(COOKIE.length + 1), pw, await getSalt(env.DB));
}

const PUBLIC = new Set(['/api/health', '/api/login', '/api/logout', '/api/session']);

export const SETUP_MESSAGE =
  'Nitrogen has no password yet. Set the APP_PASSWORD secret (wrangler secret put APP_PASSWORD, or in the Cloudflare dashboard) and reload.';

/** Marks requests the MCP server makes to the API on behalf of an authorized assistant. */
export const INTERNAL = Symbol('nitrogen-internal');
export function isInternal(env: object): boolean {
  return (env as Record<symbol, unknown>)[INTERNAL] === true;
}

/** The connected assistant's name, set alongside INTERNAL by the MCP server. */
export const ACTOR = Symbol('nitrogen-actor');

/** Who is making this request: an assistant over MCP, or the owner in the app. */
export function actorOf(env: object): Actor {
  return isInternal(env) ? agent((env as Record<symbol, unknown>)[ACTOR] as string) : YOU;
}

/** Refuses to run open, blocks cross-site writes, and requires a session for the API. */
export const guard: MiddlewareHandler<Env> = async (c, next) => {
  const path = c.req.path;
  if (isInternal(c.env)) return next();
  if (path === '/api/health') return next();
  if (!c.env.APP_PASSWORD) return c.json({ error: 'setup', message: SETUP_MESSAGE }, 503);

  if (c.req.method !== 'GET' && c.req.method !== 'HEAD') {
    const origin = c.req.header('Origin');
    if (origin && new URL(origin).host !== new URL(c.req.url).host) {
      return c.json({ error: 'forbidden', message: 'Cross-site request blocked.' }, 403);
    }
    const ct = (c.req.header('Content-Type') ?? '').toLowerCase();
    const upload = c.req.method === 'POST' && path === '/api/files';
    if (upload ? !ct.startsWith('image/') : !ct.startsWith('application/json')) {
      return c.json({ error: 'unsupported', message: 'Send JSON.' }, 415);
    }
  }

  if (PUBLIC.has(path)) return next();
  if (!(await isSignedIn(c)))
    return c.json({ error: 'unauthorized', message: 'Sign in first.' }, 401);
  return next();
};
