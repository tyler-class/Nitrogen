export interface Check {
  name: string;
  ok: boolean;
  detail?: string;
  fix?: string;
}

export interface DoctorOptions {
  url: string;
  fetchImpl?: typeof fetch;
  /** Extra checks that need gh / GitHub (e.g. installation, workflow runs). */
  extra?: () => Promise<Check[]>;
}

/** Read-only health checks against a deployed Worker. */
export async function runDoctor(o: DoctorOptions): Promise<Check[]> {
  const f = o.fetchImpl ?? fetch;
  const base = o.url.replace(/\/$/, '');
  const checks: Check[] = [];
  const get = async (path: string, init?: RequestInit) => {
    try {
      return await f(`${base}${path}`, { redirect: 'manual', ...init });
    } catch (e) {
      return new Response(String(e), { status: 599 });
    }
  };
  const h = await get('/api/health');
  let health: Record<string, unknown> | null = null;
  if (h.ok) health = (await h.json()) as Record<string, unknown>;
  checks.push({ name: 'Worker reachable', ok: !!health, detail: health ? `version ${String(health.version)}` : `HTTP ${h.status}`, fix: 'Run `nitrogen setup` (deploy step) or check the Worker URL.' });
  if (health) {
    const d1 = health.d1 as { migrated: boolean; pages: number };
    checks.push({ name: 'D1 migrations applied', ok: d1.migrated, detail: `${d1.pages} page(s) indexed`, fix: 'wrangler d1 migrations apply DB --remote' });
    checks.push({ name: 'KV bound (OAUTH_KV)', ok: health.kv === true, fix: 'Re-run setup to create the KV namespace.' });
    for (const [k, v] of Object.entries(health.secrets as Record<string, boolean>))
      checks.push({ name: `Secret ${k}`, ok: v, fix: `nitrogen setup --fix (or: wrangler secret put ${k})` });
    checks.push({ name: 'Sign-in allowlist set', ok: Number(health.allowlist) > 0, fix: 'Set ALLOWED_GITHUB_IDS.' });
    const repo = health.repo as { owner: string | null; repo: string | null };
    checks.push({ name: 'Notes repo configured', ok: !!repo.owner && !!repo.repo, detail: `${repo.owner}/${repo.repo}` });
  }
  const as = await get('/.well-known/oauth-authorization-server');
  checks.push({ name: 'OAuth authorization server metadata', ok: as.ok, detail: `HTTP ${as.status}` });
  const pr = await get('/.well-known/oauth-protected-resource');
  const pr2 = pr.ok ? pr : await get('/.well-known/oauth-protected-resource/mcp');
  checks.push({ name: 'OAuth protected resource metadata', ok: pr2.ok, detail: `HTTP ${pr2.status}` });
  const mcp = await get('/mcp', { method: 'POST', headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream' }, body: '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{}}' });
  const www = mcp.headers.get('www-authenticate') ?? '';
  checks.push({ name: 'Unauthenticated MCP returns 401 + WWW-Authenticate', ok: mcp.status === 401 && /Bearer/i.test(www), detail: `HTTP ${mcp.status}` });
  const api = await get('/api/tree');
  checks.push({ name: 'API requires a session', ok: api.status === 401, detail: `HTTP ${api.status}` });
  checks.push({ name: 'HSTS header', ok: !!api.headers.get('strict-transport-security') });
  checks.push({ name: 'CSP header', ok: !!api.headers.get('content-security-policy') });
  if (o.extra) checks.push(...(await o.extra()));
  return checks;
}

export function formatChecks(checks: Check[]): string {
  return checks.map((c) => `${c.ok ? '✔' : '✘'} ${c.name}${c.detail ? ` (${c.detail})` : ''}${!c.ok && c.fix ? `\n    fix: ${c.fix}` : ''}`).join('\n');
}
