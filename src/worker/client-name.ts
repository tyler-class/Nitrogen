// The display name of a connected assistant, for "edited by …". Clients either register (stored in
// KV as client:<id>) or identify with a Client ID Metadata Document URL (Claude does:
// https://claude.ai/oauth/mcp-oauth-client-metadata), which is fetched for its client_name.

export const UNKNOWN_ASSISTANT = 'An assistant';

const KNOWN_HOSTS: [RegExp, string][] = [
  [/(^|\.)(claude\.ai|anthropic\.com)$/, 'Claude'],
  [/(^|\.)(chatgpt\.com|openai\.com)$/, 'ChatGPT'],
  [/(^|\.)(gemini\.google\.com)$/, 'Gemini'],
];

export async function clientDisplayName(
  env: Cloudflare.Env,
  clientId: string,
  shown?: string | null,
): Promise<string> {
  const clean = (s: unknown) => (typeof s === 'string' ? s.trim().slice(0, 80) : '');
  const registered = await env.OAUTH_KV.get<{ clientName?: string }>(
    `client:${clientId}`,
    'json',
  ).catch(() => null);
  if (clean(registered?.clientName)) return clean(registered!.clientName);
  if (/^https:\/\//.test(clientId)) {
    const doc = await fetch(clientId, { signal: AbortSignal.timeout(3000) })
      .then((r) => (r.ok ? (r.json() as Promise<{ client_name?: string }>) : null))
      .catch(() => null);
    if (clean(doc?.client_name)) return clean(doc!.client_name);
    const host = new URL(clientId).hostname;
    for (const [re, name] of KNOWN_HOSTS) if (re.test(host)) return name;
  }
  return clean(shown) || UNKNOWN_ASSISTANT;
}

const cache = new Map<string, { name: string; at: number }>();

/** The connected assistant's name for an MCP request: the sign-in's saved name when it has a real
 * one, else looked up from the client id (cached for a day per Worker instance). */
export async function requestActorName(
  env: Cloudflare.Env,
  saved: string | undefined,
  clientId: string | undefined,
): Promise<string> {
  if (saved && saved !== UNKNOWN_ASSISTANT) return saved;
  if (!clientId) return saved || UNKNOWN_ASSISTANT;
  const hit = cache.get(clientId);
  if (hit && Date.now() - hit.at < 86_400_000) return hit.name;
  const name = await clientDisplayName(env, clientId).catch(() => UNKNOWN_ASSISTANT);
  cache.set(clientId, { name, at: Date.now() });
  return name;
}
