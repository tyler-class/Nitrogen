// Worker entry. OAuthProvider sits in front so AI assistants can connect over MCP:
//   /mcp            → MCP server (needs an OAuth token)
//   /authorize      → consent page (approve with the wiki password)
//   /oauth/*, /.well-known/* → handled by the provider
//   /api/*          → the app's REST API (cookie session)
//   /files/*        → images from R2 (cookie session)
import { OAuthProvider } from '@cloudflare/workers-oauth-provider';
import { app } from './app';
import { handleAuthorize } from './consent';
import { mcpApiHandler } from './mcp';
import { serveFile } from './routes/files';
import { drainIndex } from './search';

const defaultHandler = {
  fetch(
    request: Request,
    env: Cloudflare.Env,
    ctx: ExecutionContext,
  ): Response | Promise<Response> {
    const path = new URL(request.url).pathname;
    if (path === '/authorize') return handleAuthorize(request, env);
    if (path.startsWith('/files/')) return serveFile(request, env);
    return app.fetch(request, env, ctx);
  },
};

// The public URL isn't known until deploy, so build one provider per origin the Worker is reached on.
const providers = new Map<string, OAuthProvider<Cloudflare.Env>>();
function providerFor(origin: string) {
  let p = providers.get(origin);
  if (!p) {
    p = new OAuthProvider<Cloudflare.Env>({
      apiRoute: '/mcp',
      apiHandler: mcpApiHandler,
      defaultHandler,
      authorizeEndpoint: '/authorize',
      tokenEndpoint: '/oauth/token',
      clientRegistrationEndpoint: '/oauth/register',
      scopesSupported: ['wiki'],
      requiredScopes: ['wiki'],
      resourceMetadata: { resource: `${origin}/mcp`, authorization_servers: [origin] },
      clientIdMetadataDocumentEnabled: true,
    });
    providers.set(origin, p);
  }
  return p;
}

/** OAuth needs HTTPS (or localhost). Plain http elsewhere only happens in local dev on a LAN. */
function oauthCapable(url: URL): boolean {
  return url.protocol === 'https:' || ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname);
}

export default {
  fetch(request: Request, env: Cloudflare.Env, ctx: ExecutionContext) {
    const url = new URL(request.url);
    if (!oauthCapable(url)) {
      if (
        url.pathname.startsWith('/mcp') ||
        url.pathname.startsWith('/oauth/') ||
        url.pathname.startsWith('/.well-known/')
      ) {
        return Response.json(
          { error: 'https_required', message: 'Connecting assistants needs HTTPS.' },
          { status: 503 },
        );
      }
      return defaultHandler.fetch(request, env, ctx);
    }
    return providerFor(url.origin).fetch(request, env, ctx);
  },

  /** Catches up on semantic indexing that failed or was skipped during requests. */
  async scheduled(_event: ScheduledController, env: Cloudflare.Env) {
    try {
      let total = 0;
      for (let i = 0; i < 5; i++) {
        const n = await drainIndex(env, 10);
        total += n;
        if (n < 10) break;
      }
      if (total) console.log(`semantic index: ${total} page(s) indexed`);
    } catch (e) {
      console.warn('semantic index unavailable:', e instanceof Error ? e.message : e);
    }
  },
} satisfies ExportedHandler<Cloudflare.Env>;
