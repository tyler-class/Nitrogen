import { afterEach, describe, expect, it, vi } from 'vitest';
import { clientDisplayName, requestActorName } from '../../src/worker/client-name';

const env = (record: unknown = null) =>
  ({ OAUTH_KV: { get: async () => record } }) as unknown as Cloudflare.Env;

afterEach(() => vi.unstubAllGlobals());

describe('assistant names', () => {
  it('uses a registered client name', async () => {
    expect(await clientDisplayName(env({ clientName: 'Cursor' }), 'abc')).toBe('Cursor');
  });

  it('reads client_name from a metadata URL, else knows the host', async () => {
    vi.stubGlobal('fetch', async () => Response.json({ client_name: 'Claude' }));
    expect(
      await clientDisplayName(env(), 'https://claude.ai/oauth/mcp-oauth-client-metadata'),
    ).toBe('Claude');
    vi.stubGlobal('fetch', async () => new Response('no', { status: 403 }));
    expect(await clientDisplayName(env(), 'https://chatgpt.com/meta')).toBe('ChatGPT');
    expect(await clientDisplayName(env(), 'https://unknown.example/meta')).toBe('An assistant');
  });

  it('replaces a saved "An assistant" per request, and keeps real saved names', async () => {
    vi.stubGlobal('fetch', async () => Response.json({ client_name: 'Claude' }));
    expect(await requestActorName(env(), 'An assistant', 'https://claude.ai/m')).toBe('Claude');
    expect(await requestActorName(env(), undefined, 'https://claude.ai/m')).toBe('Claude');
    expect(await requestActorName(env(), 'Cursor', 'https://claude.ai/m')).toBe('Cursor');
  });
});
