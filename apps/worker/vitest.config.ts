import { defineConfig } from 'vitest/config';
import { cloudflareTest, readD1Migrations } from '@cloudflare/vitest-pool-workers';

export default defineConfig(async () => {
  const migrations = await readD1Migrations(new URL('./migrations', import.meta.url).pathname);
  return {
    plugins: [
      cloudflareTest({
        wrangler: { configPath: new URL('./wrangler.test.jsonc', import.meta.url).pathname },
        miniflare: {
          bindings: {
            TEST_MIGRATIONS: migrations,
            SESSION_SECRET: 'test-session-secret-0123456789',
            INGEST_HMAC_SECRET: 'test-ingest-secret',
            GITHUB_WEBHOOK_SECRET: 'test-webhook-secret',
            GITHUB_OAUTH_CLIENT_ID: 'Iv1.test',
            GITHUB_OAUTH_CLIENT_SECRET: 'test-client-secret',
            GITHUB_TEST_TOKEN: 'ghs_test_token',
            COOKIE_ENCRYPTION_KEY: 'test-cookie-key',
          },
        },
      }),
    ],
    test: { name: 'worker', include: ['test/**/*.test.ts'], setupFiles: [new URL('./test/setup.ts', import.meta.url).pathname], testTimeout: 30000 },
  };
});
