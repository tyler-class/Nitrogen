/** PWA sign-in with GitHub (web flow), restricted to ALLOWED_GITHUB_IDS. */
import { Hono } from 'hono';
import { getCookie, setCookie, deleteCookie } from 'hono/cookie';
import { allowedIds, type Env } from '../env.ts';
import { clearSession, issueSession, sign, verify, type SessionUser } from './session.ts';
import { randomToken } from '../util/crypto.ts';

const STATE_COOKIE = 'n2_oauth_state';

export function githubWeb(env: Env): string {
  return env.GITHUB_WEB ?? 'https://github.com';
}

export async function exchangeCode(env: Env, code: string, redirectUri: string): Promise<SessionUser> {
  const f = env.GITHUB_FETCH ?? fetch.bind(globalThis);
  const tokRes = await f(`${githubWeb(env)}/login/oauth/access_token`, {
    method: 'POST',
    headers: { accept: 'application/json', 'content-type': 'application/json', 'user-agent': 'nitrogen' },
    body: JSON.stringify({ client_id: env.GITHUB_OAUTH_CLIENT_ID, client_secret: env.GITHUB_OAUTH_CLIENT_SECRET, code, redirect_uri: redirectUri }),
  });
  const tok = (await tokRes.json()) as { access_token?: string; error?: string };
  if (!tok.access_token) throw new Error(`GitHub sign-in failed: ${tok.error ?? tokRes.status}`);
  const userRes = await f(`${env.GITHUB_API ?? 'https://api.github.com'}/user`, {
    headers: { authorization: `Bearer ${tok.access_token}`, accept: 'application/vnd.github+json', 'user-agent': 'nitrogen' },
  });
  if (!userRes.ok) throw new Error(`GitHub /user failed: ${userRes.status}`);
  const u = (await userRes.json()) as { id: number; login: string; name?: string; avatar_url?: string };
  return { id: u.id, login: u.login, ...(u.name ? { name: u.name } : {}), ...(u.avatar_url ? { avatar: u.avatar_url } : {}) };
}

export function authorizeUrl(env: Env, redirectUri: string, state: string): string {
  const q = new URLSearchParams({ client_id: env.GITHUB_OAUTH_CLIENT_ID ?? '', redirect_uri: redirectUri, state, allow_signup: 'false' });
  return `${githubWeb(env)}/login/oauth/authorize?${q}`;
}

function safeReturn(to: string | undefined): string {
  return to && to.startsWith('/') && !to.startsWith('//') ? to : '/';
}

export const loginRoutes = new Hono<{ Bindings: Env }>();

loginRoutes.get('/login', async (c) => {
  if (!c.env.GITHUB_OAUTH_CLIENT_ID) return c.text('GitHub sign-in is not configured. Run `nitrogen setup`.', 503);
  const nonce = randomToken(16);
  const returnTo = safeReturn(c.req.query('return'));
  const secure = new URL(c.req.url).protocol === 'https:';
  setCookie(c, STATE_COOKIE, await sign(c.env, { nonce, returnTo, exp: Date.now() + 600_000 }), { httpOnly: true, secure, sameSite: 'Lax', path: '/auth', maxAge: 600 });
  return c.redirect(authorizeUrl(c.env, `${new URL(c.req.url).origin}/auth/callback`, nonce));
});

loginRoutes.get('/callback', async (c) => {
  const st = await verify<{ nonce: string; returnTo: string; exp: number }>(c.env, getCookie(c, STATE_COOKIE));
  deleteCookie(c, STATE_COOKIE, { path: '/auth' });
  const code = c.req.query('code');
  if (!st || st.exp < Date.now() || st.nonce !== c.req.query('state') || !code) return c.text('Sign-in expired or was tampered with. Start again from the home page.', 400);
  let user: SessionUser;
  try {
    user = await exchangeCode(c.env, code, `${new URL(c.req.url).origin}/auth/callback`);
  } catch (e) {
    return c.text((e as Error).message, 502);
  }
  if (!allowedIds(c.env).has(user.id)) return c.text(`GitHub user ${user.login} (${user.id}) is not allowed on this wiki. Add the id to ALLOWED_GITHUB_IDS.`, 403);
  await issueSession(c, user);
  return c.redirect(st.returnTo);
});

loginRoutes.post('/logout', (c) => {
  clearSession(c);
  return c.json({ ok: true });
});
