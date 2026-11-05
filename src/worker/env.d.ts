// Secrets aren't in wrangler.jsonc, so `wrangler types` can't see them.
declare namespace Cloudflare {
  interface Env {
    /** The wiki password. Set with `wrangler secret put APP_PASSWORD`. */
    APP_PASSWORD?: string;
    /** Injected by OAuthProvider into the default handler. */
    OAUTH_PROVIDER?: import('@cloudflare/workers-oauth-provider').OAuthHelpers;
  }
}
