// The /authorize page an AI assistant sends you to. You approve it with the wiki password.
import {
  AuthorizationError,
  CimdFetchError,
  type OAuthHelpers,
} from '@cloudflare/workers-oauth-provider';
import {
  clearFailures,
  passwordMatches,
  recordFailure,
  tooManyFailures,
  WINDOW_MINUTES,
} from './auth';
import { MCP_USER } from './routes/connections';

const esc = (v: string) => v.replace(/[&<>"']/g, (ch) => `&#${ch.charCodeAt(0)};`);

interface PageInfo {
  clientName: string;
  clientDomain?: string;
  redirectHost: string;
  loopback: boolean;
}

function page(info: PageInfo, handle: string, error = ''): string {
  const name = esc(info.clientName);
  const who = info.clientDomain
    ? `Published by <strong>${esc(info.clientDomain)}</strong>.`
    : 'This app named itself, so its name isn’t verified.';
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<title>Connect ${name} to Nitrogen</title>
<link rel="icon" href="/favicon.svg" type="image/svg+xml">
<style>
:root{--bg:#ffffff;--surface:#f8f8f6;--ink:#17191c;--soft:#5f6672;--line:#e6e7e4;--accent:#2b6e55;--tint:#e8f2ed;--danger:#a33a32;color-scheme:light}
@media (prefers-color-scheme:dark){:root{--bg:#15171a;--surface:#1b1e22;--ink:#e8e9e6;--soft:#a7adb6;--line:#2c3036;--accent:#6cc3a0;--tint:#1d3329;--danger:#f08a80;color-scheme:dark}}
*{box-sizing:border-box}body{margin:0;min-height:100vh;display:grid;place-items:center;background:var(--bg);color:var(--ink);font:16px/1.5 ui-sans-serif,-apple-system,"Segoe UI",system-ui,sans-serif;padding:24px max(16px,env(safe-area-inset-left)) 24px max(16px,env(safe-area-inset-right))}
main{width:100%;max-width:380px;display:flex;flex-direction:column;gap:18px}
.mark{width:48px;height:48px;border-radius:14px;background:var(--accent)}
h1{font-size:24px;line-height:1.2;letter-spacing:-.02em;margin:0;font-weight:600;text-wrap:balance}
p{margin:0;color:var(--soft);font-size:14px}strong{color:var(--ink);font-weight:600}
.warn{background:var(--tint);color:var(--accent);padding:10px 12px;border-radius:10px}
label{font-size:12px;color:var(--soft)}
input[type=password]{width:100%;font:inherit;font-size:16px;color:var(--ink);background:transparent;border:0;border-bottom:1px solid var(--line);padding:8px 0;margin-top:4px}
input:focus{outline:none;border-bottom-color:var(--ink)}
.err{color:var(--danger);font-size:14px}
.row{display:flex;flex-direction:row-reverse;gap:8px;justify-content:flex-start}
button{font:inherit;font-size:15px;border:0;border-radius:999px;padding:10px 18px;cursor:pointer}
.allow{background:var(--ink);color:var(--bg);font-weight:500}.deny{background:none;color:var(--soft)}
</style></head><body><main>
<img class="mark" src="/favicon.svg" alt="">
<h1>Let ${name} use your wiki?</h1>
<p>It will be able to read, search, create, edit, move and delete pages in your Nitrogen wiki.</p>
<p>${who} Access goes to <strong>${esc(info.redirectHost)}</strong>.</p>
${info.loopback ? '<p class="warn">This sends access to an app on your computer. Continue only if you just started connecting from it.</p>' : ''}
<form method="post">
<input type="hidden" name="handle" value="${esc(handle)}">
<input type="hidden" name="client_name" value="${name}">
<input type="hidden" name="client_domain" value="${esc(info.clientDomain ?? '')}">
<input type="hidden" name="redirect_host" value="${esc(info.redirectHost)}">
<input type="hidden" name="loopback" value="${info.loopback ? '1' : ''}">
<label for="pw">Wiki password</label>
<input id="pw" name="password" type="password" autocomplete="current-password" autofocus>
${error ? `<p class="err" role="alert">${esc(error)}</p>` : ''}
<div class="row" style="margin-top:18px"><button class="allow" name="decision" value="approve">Allow</button><button class="deny" name="decision" value="deny">Cancel</button></div>
</form></main></body></html>`;
}

function html(body: string, headers: Headers = new Headers(), status = 200) {
  headers.set('Content-Type', 'text/html; charset=utf-8');
  headers.set('X-Frame-Options', 'DENY');
  headers.set(
    'Content-Security-Policy',
    "default-src 'none'; style-src 'unsafe-inline'; img-src 'self'; frame-ancestors 'none'",
  );
  return new Response(body, { status, headers });
}

function plainError(message: string, status = 400) {
  return html(
    `<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>Nitrogen</title><p style="font:16px system-ui;padding:24px">${esc(message)}</p>`,
    new Headers(),
    status,
  );
}

export async function handleAuthorize(request: Request, env: Cloudflare.Env): Promise<Response> {
  const oauth = env.OAUTH_PROVIDER as OAuthHelpers;
  if (!env.APP_PASSWORD)
    return plainError('Set the APP_PASSWORD secret before connecting assistants.', 503);
  try {
    if (request.method === 'GET') {
      const authReq = await oauth.parseAuthRequest(request);
      const d = await oauth.describeConsent(authReq);
      const consent = await oauth.beginConsent(authReq);
      return html(
        page(
          {
            clientName: d.clientName,
            clientDomain: d.clientDomain,
            redirectHost: d.redirectHost,
            loopback: d.redirectIsLoopback,
          },
          consent.handle,
        ),
        consent.headers,
      );
    }
    if (request.method !== 'POST') return plainError('Method not allowed.', 405);

    const form = await request.formData();
    const handle = String(form.get('handle') ?? '');
    if (form.get('decision') !== 'approve') {
      const denied = await oauth.denyConsent(request, handle);
      return new Response(null, { status: 302, headers: denied.headers });
    }
    const info: PageInfo = {
      clientName: String(form.get('client_name') ?? 'This app'),
      clientDomain: String(form.get('client_domain') ?? '') || undefined,
      redirectHost: String(form.get('redirect_host') ?? ''),
      loopback: form.get('loopback') === '1',
    };
    const ip = request.headers.get('CF-Connecting-IP') ?? 'unknown';
    if (await tooManyFailures(env.DB, ip)) {
      return html(
        page(info, handle, `Too many wrong passwords. Try again in ${WINDOW_MINUTES} minutes.`),
        new Headers(),
        429,
      );
    }
    if (!(await passwordMatches(String(form.get('password') ?? ''), env.APP_PASSWORD))) {
      await recordFailure(env.DB, ip);
      return html(page(info, handle, 'That password is not right.'), new Headers(), 401);
    }
    await clearFailures(env.DB, ip);
    const approved = await oauth.approveConsent(request, handle, { scope: ['wiki'] });
    const { redirectTo } = await oauth.completeAuthorization({
      request: approved.request,
      userId: MCP_USER,
      metadata: {},
      scope: approved.request.scope,
      props: { owner: true },
    });
    approved.headers.set('Location', redirectTo);
    return new Response(null, { status: 302, headers: approved.headers });
  } catch (error) {
    if (error instanceof AuthorizationError && error.redirectTo)
      return Response.redirect(error.redirectTo, 302);
    if (error instanceof AuthorizationError)
      return plainError(`${error.description} Start connecting again from your assistant.`);
    if (error instanceof CimdFetchError) return plainError('This app could not be verified.');
    throw error;
  }
}
