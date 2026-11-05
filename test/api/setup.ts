import { applyD1Migrations, env } from 'cloudflare:test';

declare module 'cloudflare:test' {
  interface ProvidedEnv {
    TEST_MIGRATIONS: import('cloudflare:test').D1Migration[];
  }
}

await applyD1Migrations(
  env.DB,
  (env as unknown as { TEST_MIGRATIONS: import('cloudflare:test').D1Migration[] }).TEST_MIGRATIONS,
);
