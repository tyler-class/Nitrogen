// Keeps the installed app (iOS home screen especially) on the latest deploy.
//
// iOS resumes a home-screen app from memory instead of reloading it, so a new deploy is never
// noticed on its own. Three things fix that (same approach as Ratio):
// 1. Pages (HTML) are fetched network-first by the service worker (vite.config.ts), so any real
//    load gets the newest build when online. Hashed JS/CSS stay cached; they never change.
// 2. Whenever the app comes back to the foreground (and every 30 minutes while open) we ask the
//    browser to check for a new service worker. When one is ready we switch to it and reload,
//    but never while something is being edited or a pop-up is open.
// 3. About Nitrogen has "Check for updates" for doing it by hand.
import { registerSW } from 'virtual:pwa-register';

let reg: ServiceWorkerRegistration | undefined;
let pending = false;
let updateSW: ((reload?: boolean) => Promise<void>) | undefined;

/** Reloading now could lose work or yank something open out from under the user. */
function busy(): boolean {
  if (
    document.querySelector(
      '.sheet-ov, .scrim, .palette, .page.editing, .menu, .picker-pop, .emoji-pop, .lightbox, .nav-open',
    )
  )
    return true;
  const el = document.activeElement as HTMLElement | null;
  return !!el?.closest('input, textarea, [contenteditable="true"]');
}

let applying = false;

function applyIfIdle(force = false) {
  if (!pending || !updateSW || (!force && busy()) || applying) return;
  applying = true;
  // vite-plugin-pwa only reloads when the page was already controlled when it loaded, so after a
  // first visit (or a fresh install) the new worker would take over silently. Reload ourselves
  // once it does.
  navigator.serviceWorker?.addEventListener('controllerchange', () => window.location.reload(), {
    once: true,
  });
  void updateSW(true);
  // If the worker never takes over (it was replaced meanwhile), let the next check try again.
  setTimeout(() => (applying = false), 10_000);
}

function check() {
  void reg?.update().catch(() => {
    /* offline: try again next time */
  });
}

export function startPwa() {
  updateSW = registerSW({
    immediate: true,
    onNeedRefresh() {
      pending = true;
      applyIfIdle();
    },
    onRegisteredSW(_url, r) {
      reg = r;
    },
  });
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState !== 'visible') return;
    check();
    applyIfIdle();
  });
  // Waiting on an open pop-up or the editor: apply as soon as it closes.
  setInterval(() => applyIfIdle(), 3000);
  setInterval(() => document.visibilityState === 'visible' && check(), 30 * 60 * 1000);
}

/** For the "Check for updates" button. Reloads into a new version if there is one. */
export async function checkForUpdate(): Promise<'updating' | 'latest'> {
  if (!reg) {
    // No service worker (dev, private mode): a plain reload already gets the newest build.
    window.location.reload();
    return 'updating';
  }
  if (pending || reg.waiting) {
    pending = true;
    applyIfIdle(true);
    return 'updating';
  }
  await reg.update();
  const sw = reg.installing ?? reg.waiting;
  if (!sw) return 'latest';
  if (sw.state !== 'installed') {
    await new Promise<void>((done) => {
      const on = () => (sw.state === 'installed' || sw.state === 'redundant') && done();
      sw.addEventListener('statechange', on);
      setTimeout(done, 15000);
    });
  }
  pending = true;
  applyIfIdle(true);
  return 'updating';
}
