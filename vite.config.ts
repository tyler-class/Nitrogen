import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { cloudflare } from '@cloudflare/vite-plugin';
import { VitePWA } from 'vite-plugin-pwa';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import type { Plugin } from 'vite';

const remote = process.env.N2_REMOTE === '1';

/**
 * Serves the emoji picker's data (emojibase, English) from our own origin at /emojibase/16/en/,
 * so the picker works offline and nothing is fetched from a CDN.
 */
function emojiData(): Plugin {
  const require = createRequire(import.meta.url);
  const files = ['data.json', 'messages.json'];
  const read = (f: string) => readFileSync(require.resolve(`emojibase-data/en/${f}`));
  return {
    name: 'nitrogen-emoji-data',
    configureServer(server) {
      server.middlewares.use((req, res, next) => {
        const f = files.find((name) => req.url === `/emojibase/16/en/${name}`);
        if (!f) return next();
        res.setHeader('Content-Type', 'application/json');
        res.end(read(f));
      });
    },
    generateBundle() {
      if (this.environment.name !== 'client') return;
      for (const f of files)
        this.emitFile({ type: 'asset', fileName: `emojibase/16/en/${f}`, source: read(f) });
    },
  };
}

export default defineConfig(({ command }) => ({
  plugins: [
    react(),
    emojiData(),
    // AI Search only runs on Cloudflare. Local dev uses keyword search unless N2_REMOTE=1
    // (which needs `wrangler login` and talks to your real AI Search instance).
    cloudflare({
      remoteBindings: remote,
      // Only for `vite dev`: production builds keep wrangler.jsonc's SEMANTIC_SEARCH="on".
      config: command === 'serve' && !remote ? { vars: { SEMANTIC_SEARCH: 'off' } } : {},
    }),
    VitePWA({
      registerType: 'autoUpdate',
      injectRegister: false,
      includeAssets: ['favicon.svg', 'icons/apple-touch-icon.png'],
      manifest: {
        name: 'Nitrogen',
        short_name: 'Nitrogen',
        description: 'A personal wiki.',
        display: 'standalone',
        start_url: '/',
        scope: '/',
        theme_color: '#ffffff',
        background_color: '#ffffff',
        icons: [
          { src: '/icons/icon-192.png', sizes: '192x192', type: 'image/png' },
          { src: '/icons/icon-512.png', sizes: '512x512', type: 'image/png' },
          {
            src: '/icons/icon-maskable-512.png',
            sizes: '512x512',
            type: 'image/png',
            purpose: 'maskable',
          },
        ],
      },
      workbox: {
        globPatterns: ['**/*.{js,css,html,svg,png,woff2}'],
        // CodeMirror's language data splits into many small chunks; precache the app shell only.
        maximumFileSizeToCacheInBytes: 3 * 1024 * 1024,
        navigateFallback: '/index.html',
        navigateFallbackDenylist: [
          /^\/api\//,
          /^\/files\//,
          /^\/u\//,
          /^\/mcp/,
          /^\/authorize/,
          /^\/oauth\//,
          /^\/\.well-known\//,
        ],
        runtimeCaching: [
          {
            // The tree and recently opened pages stay readable offline.
            urlPattern: ({ url, request }) =>
              request.method === 'GET' &&
              (url.pathname === '/api/tree' || /^\/api\/pages\/[^/]+$/.test(url.pathname)),
            handler: 'NetworkFirst',
            options: {
              cacheName: 'nitrogen-api',
              networkTimeoutSeconds: 4,
              expiration: { maxEntries: 100, maxAgeSeconds: 30 * 86400 },
              cacheableResponse: { statuses: [200] },
            },
          },
          {
            // Emoji picker data: versioned path, never changes.
            urlPattern: ({ url }) => url.pathname.startsWith('/emojibase/'),
            handler: 'CacheFirst',
            options: {
              cacheName: 'nitrogen-emoji',
              cacheableResponse: { statuses: [200] },
            },
          },
          {
            // Image keys are content-addressed (never rewritten), so cache-first is safe.
            urlPattern: ({ url }) => url.pathname.startsWith('/files/'),
            handler: 'CacheFirst',
            options: {
              cacheName: 'nitrogen-files',
              expiration: { maxEntries: 300, maxAgeSeconds: 90 * 86400 },
              cacheableResponse: { statuses: [200] },
            },
          },
        ],
      },
    }),
  ],
  resolve: {
    alias: { '@shared': fileURLToPath(new URL('./src/shared', import.meta.url)) },
  },
}));
