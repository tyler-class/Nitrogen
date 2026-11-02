import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { VitePWA } from 'vite-plugin-pwa';

export default defineConfig({
  plugins: [
    react(),
    VitePWA({
      registerType: 'autoUpdate',
      injectRegister: false,
      includeAssets: ['favicon.svg', 'icons/*.png'],
      manifest: {
        name: 'Nitrogen',
        short_name: 'Nitrogen',
        description: 'Your wiki in a GitHub repo.',
        theme_color: '#ffffff',
        background_color: '#ffffff',
        display: 'standalone',
        start_url: '/',
        icons: [
          { src: '/icons/icon-192.png', sizes: '192x192', type: 'image/png' },
          { src: '/icons/icon-512.png', sizes: '512x512', type: 'image/png' },
          { src: '/icons/icon-maskable-512.png', sizes: '512x512', type: 'image/png', purpose: 'maskable' },
        ],
      },
      workbox: {
        navigateFallback: '/index.html',
        navigateFallbackDenylist: [/^\/(api|auth|oauth|mcp|hooks|admin|\.well-known)/],
        // Precache the shell only; lazy chunks (mermaid, editor) are cached on first use.
        globPatterns: ['index.html', 'assets/index-*.{js,css}', 'assets/Markdown-*.js', 'favicon.svg', 'icons/*.png'],
        runtimeCaching: [
          { urlPattern: ({ url }) => url.pathname.startsWith('/assets/'), handler: 'CacheFirst', options: { cacheName: 'n2-chunks', expiration: { maxEntries: 200 } } },
          { urlPattern: ({ url }) => url.pathname.startsWith('/api/blob') && url.searchParams.has('sha'), handler: 'CacheFirst', options: { cacheName: 'n2-blobs', expiration: { maxEntries: 400 } } },
          { urlPattern: ({ url }) => url.pathname.startsWith('/api/') && !url.pathname.startsWith('/api/changes'), handler: 'NetworkFirst', method: 'GET', options: { cacheName: 'n2-api', networkTimeoutSeconds: 4, expiration: { maxEntries: 300 } } },
        ],
      },
    }),
  ],
  server: { proxy: { '^/(api|auth|oauth|mcp|hooks|admin|\\.well-known|authorize|token|register)': 'http://127.0.0.1:8787' } },
  build: { target: 'es2022', sourcemap: true },
});
