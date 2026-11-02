import { createSign, randomBytes } from 'node:crypto';
import { createServer, type Server } from 'node:http';

export function appJwtNode(appId: number | string, pem: string, now = Date.now()): string {
  const b64 = (o: object) => Buffer.from(JSON.stringify(o)).toString('base64url');
  const iat = Math.floor(now / 1000) - 60;
  const head = `${b64({ alg: 'RS256', typ: 'JWT' })}.${b64({ iat, exp: iat + 600, iss: String(appId) })}`;
  const sig = createSign('RSA-SHA256').update(head).sign(pem).toString('base64url');
  return `${head}.${sig}`;
}

export interface ManifestInput {
  name: string;
  workerUrl: string;
  redirectUrl: string;
}

/** GitHub App manifest for a Nitrogen deployment (contents:write, metadata:read, push events). */
export function buildManifest(i: ManifestInput): Record<string, unknown> {
  return {
    name: i.name,
    url: i.workerUrl,
    hook_attributes: { url: `${i.workerUrl}/hooks/github`, active: true },
    redirect_url: i.redirectUrl,
    callback_urls: [`${i.workerUrl}/auth/callback`, `${i.workerUrl}/oauth/github/callback`],
    setup_url: i.workerUrl,
    description: 'Nitrogen wiki: reads and writes one notes repo.',
    public: false,
    default_events: ['push'],
    default_permissions: { contents: 'write', metadata: 'read' },
    request_oauth_on_install: false,
  };
}

export interface ConversionResult {
  id: number;
  slug: string;
  client_id: string;
  client_secret: string;
  webhook_secret: string;
  pem: string;
}

export function manifestPage(manifest: Record<string, unknown>, state: string, githubWeb = 'https://github.com', org?: string): string {
  const action = org ? `${githubWeb}/organizations/${org}/settings/apps/new?state=${state}` : `${githubWeb}/settings/apps/new?state=${state}`;
  const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;');
  return `<!doctype html><meta charset="utf-8"><title>Create the Nitrogen GitHub App</title>
<body style="font-family:system-ui;max-width:36rem;margin:4rem auto;line-height:1.5">
<h1>Create the Nitrogen GitHub App</h1>
<p>GitHub will show the app settings. Click <b>Create GitHub App</b>, then return to the terminal.</p>
<form id="f" method="post" action="${esc(action)}"><input type="hidden" name="manifest" value="${esc(JSON.stringify(manifest))}"><button>Continue to GitHub</button></form>
<script>document.getElementById('f').submit()</script></body>`;
}

/**
 * Run the manifest flow: serve an auto-submitting form on localhost, wait for GitHub to redirect
 * back with ?code&state, exchange the code. The result (with the private key) stays in memory.
 */
export async function runManifestFlow(opts: {
  name: string;
  workerUrl: string;
  open: (url: string) => void;
  fetchImpl?: typeof fetch;
  githubApi?: string;
  githubWeb?: string;
  org?: string;
  timeoutMs?: number;
}): Promise<ConversionResult> {
  const state = randomBytes(16).toString('hex');
  const f = opts.fetchImpl ?? fetch;
  let server: Server | undefined;
  try {
    const code = await new Promise<string>((resolve, reject) => {
      server = createServer((req, res) => {
        const url = new URL(req.url ?? '/', 'http://localhost');
        if (url.pathname === '/start') {
          const port = (server!.address() as { port: number }).port;
          const manifest = buildManifest({ name: opts.name, workerUrl: opts.workerUrl, redirectUrl: `http://localhost:${port}/callback` });
          res.writeHead(200, { 'content-type': 'text/html' }).end(manifestPage(manifest, state, opts.githubWeb, opts.org));
        } else if (url.pathname === '/callback') {
          if (url.searchParams.get('state') !== state) {
            res.writeHead(400).end('State mismatch. Start setup again.');
            reject(new Error('Manifest flow state mismatch.'));
            return;
          }
          res.writeHead(200, { 'content-type': 'text/html' }).end('<p style="font-family:system-ui">GitHub App created. Return to the terminal.</p>');
          resolve(url.searchParams.get('code') ?? '');
        } else res.writeHead(404).end();
      });
      server.listen(0, '127.0.0.1', () => {
        const port = (server!.address() as { port: number }).port;
        opts.open(`http://localhost:${port}/start`);
      });
      setTimeout(() => reject(new Error('Timed out waiting for GitHub (the manifest flow must finish within the hour).')), opts.timeoutMs ?? 30 * 60_000).unref();
    });
    const res = await f(`${opts.githubApi ?? 'https://api.github.com'}/app-manifests/${code}/conversions`, {
      method: 'POST',
      headers: { accept: 'application/vnd.github+json', 'user-agent': 'nitrogen-setup' },
    });
    if (!res.ok) throw new Error(`Manifest conversion failed: ${res.status}`);
    return (await res.json()) as ConversionResult;
  } finally {
    server?.close();
  }
}

export async function findInstallation(appId: number, pem: string, owner: string, fetchImpl: typeof fetch = fetch, api = 'https://api.github.com'): Promise<number | null> {
  const res = await fetchImpl(`${api}/app/installations`, { headers: { authorization: `Bearer ${appJwtNode(appId, pem)}`, accept: 'application/vnd.github+json', 'user-agent': 'nitrogen-setup' } });
  if (!res.ok) throw new Error(`Listing installations failed: ${res.status}`);
  const list = (await res.json()) as { id: number; account: { login: string } }[];
  return list.find((i) => i.account.login.toLowerCase() === owner.toLowerCase())?.id ?? null;
}
