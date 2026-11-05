// Assistants connected through MCP (OAuth grants), and revoking them.
import { Hono } from 'hono';
import { ApiError, type AppEnv } from './util';

export const MCP_USER = 'owner';
export const connections = new Hono<AppEnv>();

async function allGrants(env: Cloudflare.Env) {
  const oauth = env.OAUTH_PROVIDER;
  if (!oauth)
    throw new ApiError(503, 'unavailable', 'Assistant connections are not available here.');
  const out = [];
  let cursor: string | undefined;
  do {
    const page = await oauth.listUserGrants(MCP_USER, { cursor, limit: 100 });
    out.push(...page.items);
    cursor = page.cursor;
  } while (cursor);
  return out;
}

connections.get('/connections', async (c) => {
  const grants = await allGrants(c.env);
  const clients = await Promise.all(
    grants.map(async (g) => {
      const info = await c.env.OAUTH_PROVIDER!.lookupClient(g.clientId).catch(() => null);
      return {
        id: g.id,
        name: info?.clientName ?? 'An AI assistant',
        created_at: g.createdAt ? new Date(g.createdAt * 1000).toISOString() : null,
      };
    }),
  );
  return c.json({ connections: clients });
});

connections.post('/connections/revoke-all', async (c) => {
  const grants = await allGrants(c.env);
  await Promise.all(grants.map((g) => c.env.OAUTH_PROVIDER!.revokeGrant(g.id, MCP_USER)));
  return c.json({ ok: true, revoked: grants.length });
});
