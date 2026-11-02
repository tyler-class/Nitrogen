export interface Env {
  DB: D1Database;
  OAUTH_KV: KVNamespace;
  ASSETS?: Fetcher;
  GITHUB_OWNER: string;
  GITHUB_REPO: string;
  DEFAULT_BRANCH?: string;
  /** Comma-separated numeric GitHub user ids allowed to sign in. */
  ALLOWED_GITHUB_IDS: string;
  GITHUB_API?: string;
  GITHUB_WEB?: string;
  GITHUB_APP_ID?: string;
  GITHUB_APP_PRIVATE_KEY?: string;
  GITHUB_INSTALLATION_ID?: string;
  GITHUB_OAUTH_CLIENT_ID?: string;
  GITHUB_OAUTH_CLIENT_SECRET?: string;
  GITHUB_WEBHOOK_SECRET?: string;
  SESSION_SECRET?: string;
  INGEST_HMAC_SECRET?: string;
  COOKIE_ENCRYPTION_KEY?: string;
  /** Public base URL override (otherwise derived from the request). */
  PUBLIC_URL?: string;
  /** Test seam: replaces global fetch for GitHub calls. */
  GITHUB_FETCH?: typeof fetch;
  /** Test seam: a pre-minted installation token (skips the App JWT). */
  GITHUB_TEST_TOKEN?: string;
}

export const REQUIRED_SECRETS = [
  'GITHUB_APP_ID',
  'GITHUB_APP_PRIVATE_KEY',
  'GITHUB_INSTALLATION_ID',
  'GITHUB_OAUTH_CLIENT_ID',
  'GITHUB_OAUTH_CLIENT_SECRET',
  'GITHUB_WEBHOOK_SECRET',
  'SESSION_SECRET',
  'INGEST_HMAC_SECRET',
  'COOKIE_ENCRYPTION_KEY',
] as const;

export function allowedIds(env: Env): Set<number> {
  return new Set(
    (env.ALLOWED_GITHUB_IDS ?? '')
      .split(',')
      .map((s) => Number(s.trim()))
      .filter((n) => Number.isInteger(n) && n > 0),
  );
}

export function branch(env: Env): string {
  return env.DEFAULT_BRANCH || 'main';
}
