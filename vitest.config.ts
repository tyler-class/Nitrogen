import { defineConfig } from 'vitest/config';
import { cloudflareTest, readD1Migrations } from '@cloudflare/vitest-plugin';
import { fileURLToPath } from 'node:url';

const shared = fileURLToPath(new URL('./src/shared', import.meta.url));

export default defineConfig(async () => {
  const migrations = await readD1Migrations(
    fileURLToPath(new URL('./migrations', import.meta.url)),
  );
  return {
    test: {
      projects: [
        {
          resolve: { alias: { '@shared': shared } },
          test: { name: 'logic', include: ['test/logic/**/*.test.ts'], environment: 'node' },
        },
        {
          resolve: { alias: { '@shared': shared } },
          plugins: [
            cloudflareTest({
              // AI Search has no local simulation; tests exercise the keyword fallback.
              remoteBindings: false,
              wrangler: { configPath: './wrangler.jsonc' },
              miniflare: {
                bindings: {
                  APP_PASSWORD: 'correct horse battery staple',
                  TEST_MIGRATIONS: migrations,
                  SEMANTIC_SEARCH: 'off',
                },
              },
            }),
          ],
          test: {
            name: 'api',
            include: ['test/api/**/*.test.ts'],
            setupFiles: ['test/api/setup.ts'],
          },
        },
      ],
    },
  };
});
