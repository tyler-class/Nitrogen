import type { Context } from 'hono';
import { getCookie, setCookie, deleteCookie } from 'hono/cookie';
import { b64urlDecode, b64urlEncode, hmacB64url, randomToken, safeEqual, utf8 } from '../util/crypto.ts';
import type { Env } from '../env.ts';

export interface SessionUser {
  id: number;
  login: string;
  name?: string;
  avatar?: string;
}

interface SessionPayload extends SessionUser {
  iat: number;
  exp: number;
}

export const SESSION_COOKIE = 'n2_session';
export const CSRF_COOKIE = 'n2_csrf';
const DAY = 86_400;
const SESSION_DAYS = 30;

function secret(env: Env): string {
  if (!env.SESSION_SECRET || env.SESSION_SECRET.length < 16) throw new Error('SESSION_SECRET is not set.');
  return env.SESSION_SECRET;
}

export async function sign(env: Env, data: object): Promise<string> {
  const body = b64urlEncode(utf8(JSON.stringify(data)));
  return `${body}.${await hmacB64url(secret(env), body)}`;
}

export async function verify<T>(env: Env, token: string | undefined): Promise<T | null> {
  if (!token) return null;
  const [body, sig] = token.split('.');
  if (!body || !sig) return null;
  if (!safeEqual(sig, await hmacB64url(secret(env), body))) return null;
  try {
    return JSON.parse(new TextDecoder().decode(b64urlDecode(body))) as T;
  } catch {
    return null;
  }
}

function secure(c: Context): boolean {
  return new URL(c.req.url).protocol === 'https:';
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export async function issueSession(c: Context<any>, user: SessionUser): Promise<void> {
  const now = Math.floor(Date.now() / 1000);
  const token = await sign(c.env, { ...user, iat: now, exp: now + SESSION_DAYS * DAY } satisfies SessionPayload);
  setCookie(c, SESSION_COOKIE, token, { httpOnly: true, secure: secure(c), sameSite: 'Lax', path: '/', maxAge: SESSION_DAYS * DAY });
  if (!getCookie(c, CSRF_COOKIE)) setCookie(c, CSRF_COOKIE, randomToken(18), { httpOnly: false, secure: secure(c), sameSite: 'Strict', path: '/', maxAge: SESSION_DAYS * DAY });
}

/** Read the session; slides the expiry when older than a day. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export async function readSession(c: Context<any>, allowed: Set<number>): Promise<SessionUser | null> {
  const p = await verify<SessionPayload>(c.env, getCookie(c, SESSION_COOKIE));
  const now = Math.floor(Date.now() / 1000);
  if (!p || p.exp < now || !allowed.has(p.id)) return null;
  const user: SessionUser = { id: p.id, login: p.login, ...(p.name ? { name: p.name } : {}), ...(p.avatar ? { avatar: p.avatar } : {}) };
  if (now - p.iat > DAY) await issueSession(c, user);
  return user;
}

export function clearSession(c: Context): void {
  deleteCookie(c, SESSION_COOKIE, { path: '/' });
  deleteCookie(c, CSRF_COOKIE, { path: '/' });
}

/** Double-submit CSRF + same-origin check for mutating requests. */
export function csrfOk(c: Context): boolean {
  const origin = c.req.header('origin');
  const self = new URL(c.req.url).origin;
  if (origin && origin !== self) return false;
  const cookie = getCookie(c, CSRF_COOKIE);
  const header = c.req.header('x-csrf-token');
  return !!cookie && !!header && safeEqual(cookie, header);
}
