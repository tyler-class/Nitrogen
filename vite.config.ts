import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { cloudflare } from '@cloudflare/vite-plugin';
import { VitePWA } from 'vite-plugin-pwa';
import { fileURLToPath } from 'node:url';

const remote = process.env.N2_REMOTE === '1';

export default defineConfig(({ command }) => ({
  plugins: [
    react(),
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
