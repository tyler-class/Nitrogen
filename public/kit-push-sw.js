// Selfhost Kit: push notifications and the app-icon badge, in the service worker.
// Synced from tyler-class/selfhost-kit (kit/public/kit-push-sw.js). Edit it there, not here.
//
// Loaded by the service worker vite-plugin-pwa generates:
//   VitePWA({ workbox: { importScripts: ['kit-push-sw.js'], ... } })
// Payloads come from sendPush() in src/worker/kit/push.ts: { title, body, url, badge?, tag?, icon? }.
/* global self, clients, URL */

self.addEventListener('push', (event) => {
  let d;
  try {
    d = event.data ? event.data.json() : {};
  } catch {
    d = { body: event.data ? event.data.text() : '' };
  }
  const jobs = [
    // Every push must show a notification (userVisibleOnly), or the browser stops delivering.
    self.registration.showNotification(d.title || 'Notification', {
      body: d.body || '',
      tag: d.tag || undefined,
      icon: d.icon || '/pwa-192x192.png',
      data: { url: d.url || '/' },
    }),
  ];
  const nav = self.navigator;
  if (typeof d.badge === 'number' && nav && 'setAppBadge' in nav)
    jobs.push(d.badge > 0 ? nav.setAppBadge(d.badge) : nav.clearAppBadge());
  event.waitUntil(Promise.all(jobs.map((p) => Promise.resolve(p).catch(() => undefined))));
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const url = new URL(
    (event.notification.data && event.notification.data.url) || '/',
    self.location.origin,
  );
  if (url.origin !== self.location.origin) return;
  event.waitUntil(
    (async () => {
      const open = await clients.matchAll({ type: 'window', includeUncontrolled: true });
      const win = open.find((c) => new URL(c.url).origin === url.origin);
      if (win) {
        await win.focus();
        // The app routes it (onPushOpen in src/client/kit/push.ts), keeping its state.
        win.postMessage({ type: 'kit-push-open', url: url.pathname + url.search + url.hash });
        return;
      }
      await clients.openWindow(url.href);
    })(),
  );
});
