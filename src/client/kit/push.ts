// Selfhost Kit: turning on push notifications on this device, its choices, and the app-icon
// badge. Synced from tyler-class/selfhost-kit (kit/client/push.ts). Edit it there, not here.
//
// Talks to pushRoutes() (src/worker/kit/push.ts) under /api/push. Choices are per device:
// each family member's phone picks its own. iOS (16.4+) only has push and badges for an app
// added to the Home Screen.
//
// Settings → Notifications (every app, in its own styling, words from PUSH_TEXT):
//   1. Heading "Notifications" with an ⓘ (pushInfo()).
//   2. When it can't work here (pushBlocker()): one line. Not installed (iOS in a browser tab, or
//      no push): PUSH_TEXT.needsInstall, a link to the app's "Install on your phone" section,
//      and installSteps() behind an ⓘ. Otherwise the "Notifications on this device" switch,
//      with an ⓘ saying it works because the app is installed (PUSH_TEXT.installed).
//   3. When on: one switch per kind, each with its one-line description, then "Send a test".

export interface PushKindInfo {
  id: string;
  label: string;
  /** One short line under the switch. */
  description: string;
}

export interface PushDeviceView {
  tz: string;
  prefs: { enabled: boolean } & Record<string, boolean>;
  label: string | null;
}

export interface PushState {
  /** This browser can do push at all (installed, on iOS). */
  supported: boolean;
  standalone: boolean;
  ios: boolean;
  /** iOS in a browser tab: push needs the Home Screen app. */
  needsInstall: boolean;
  permission: NotificationPermission | 'unsupported';
  /** This device is signed up and its master switch is on. */
  on: boolean;
  /** The device's choices on the server (null: never signed up). */
  device: PushDeviceView | null;
}

let base = '/api/push';
/** Where pushRoutes() is mounted, if not /api/push. */
export function configurePush(o: { base?: string }) {
  if (o.base) base = o.base.replace(/\/$/, '');
}

async function call<T>(method: string, path: string, body?: unknown): Promise<T> {
  const r = await fetch(`${base}${path}`, {
    method,
    credentials: 'same-origin',
    headers: body === undefined ? {} : { 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const data = (await r.json().catch(() => ({}))) as { message?: string };
  if (!r.ok) throw new Error(data.message ?? `Couldn’t reach the server (${r.status}).`);
  return data as T;
}

export const isIOS = () =>
  /iphone|ipad|ipod/i.test(navigator.userAgent) ||
  (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);

/** Running as the installed app (Home Screen), not in a browser tab. */
export const isStandalone = () =>
  window.matchMedia?.('(display-mode: standalone)').matches ||
  (navigator as { standalone?: boolean }).standalone === true;

/** This browser can subscribe to push here and now. */
export const pushSupported = () =>
  typeof window !== 'undefined' &&
  'serviceWorker' in navigator &&
  'PushManager' in window &&
  'Notification' in window;

/** The service worker, or null if none comes up (dev without one, private mode). */
async function registration(timeout = 8000): Promise<ServiceWorkerRegistration | null> {
  if (!('serviceWorker' in navigator)) return null;
  return Promise.race([
    navigator.serviceWorker.ready,
    new Promise<null>((done) => setTimeout(() => done(null), timeout)),
  ]);
}

async function currentSubscription(): Promise<PushSubscription | null> {
  if (!pushSupported()) return null;
  const reg = await registration(3000);
  return (await reg?.pushManager.getSubscription()) ?? null;
}

const zone = () => Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';

/** Where this device stands. Also keeps the device's time zone current (it travels). */
export async function getState(): Promise<PushState> {
  const ios = isIOS();
  const standalone = isStandalone();
  const supported = pushSupported();
  const state: PushState = {
    supported,
    standalone,
    ios,
    needsInstall: ios && !standalone,
    permission: 'Notification' in window ? Notification.permission : 'unsupported',
    on: false,
    device: null,
  };
  const sub = await currentSubscription();
  if (!sub) return state;
  let { device } = await call<{ device: PushDeviceView | null }>('POST', '/device', {
    endpoint: sub.endpoint,
  });
  if (device && device.tz !== zone())
    ({ device } = await call<{ device: PushDeviceView }>('PATCH', '/prefs', {
      endpoint: sub.endpoint,
      tz: zone(),
    }));
  state.device = device;
  state.on = !!device?.prefs.enabled && state.permission === 'granted';
  return state;
}

function keyBytes(b64: string): Uint8Array<ArrayBuffer> {
  const s = b64.replace(/-/g, '+').replace(/_/g, '/');
  const bin = atob(s + '==='.slice((s.length + 3) % 4));
  return Uint8Array.from(bin, (c) => c.charCodeAt(0));
}

const sameKey = (sub: PushSubscription, key: Uint8Array) => {
  const have = sub.options?.applicationServerKey;
  if (!have) return false;
  const a = new Uint8Array(have);
  return a.length === key.length && a.every((x, i) => x === key[i]);
};

/**
 * Turns notifications on for this device. Call it straight from a tap (the permission prompt
 * needs one). `kinds`: the app's kinds; each starts on (or keeps this device's earlier choice).
 */
export async function enablePush(kinds: string[]): Promise<PushState> {
  if (!pushSupported()) throw new Error(PUSH_TEXT.unsupported);
  // First, while the tap still counts: Safari only prompts from a user gesture.
  const permission = await Notification.requestPermission();
  if (permission !== 'granted') throw new Error(PUSH_TEXT.blocked);
  const reg = await registration();
  if (!reg) throw new Error(PUSH_TEXT.noWorker);
  const { key } = await call<{ key: string }>('GET', '/key');
  const bytes = keyBytes(key);
  let sub = await reg.pushManager.getSubscription();
  if (sub && !sameKey(sub, bytes)) {
    await sub.unsubscribe().catch(() => undefined);
    sub = null;
  }
  sub ??= await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: bytes });
  const json = sub.toJSON();
  const old = await call<{ device: PushDeviceView | null }>('POST', '/device', {
    endpoint: sub.endpoint,
  });
  const prefs: Record<string, boolean> = { enabled: true };
  for (const k of kinds) prefs[k] = old.device?.prefs[k] ?? true;
  await call('POST', '/subscribe', {
    subscription: { endpoint: json.endpoint, keys: json.keys },
    tz: zone(),
    prefs,
  });
  await syncBadge();
  return getState();
}

/** Turns this device's notifications off (its choices are kept for next time). */
export async function disablePush(): Promise<PushState> {
  const sub = await currentSubscription();
  if (sub)
    await call('PATCH', '/prefs', { endpoint: sub.endpoint, prefs: { enabled: false } }).catch(
      () => undefined,
    );
  await setBadge(0);
  return getState();
}

/** Forgets this device entirely: unsubscribes it here and on the server. */
export async function unsubscribePush(): Promise<void> {
  const sub = await currentSubscription();
  if (!sub) return;
  await call('POST', '/unsubscribe', { endpoint: sub.endpoint }).catch(() => undefined);
  await sub.unsubscribe().catch(() => undefined);
  await setBadge(0);
}

/** Switches kinds on or off for this device: setPrefs({ todos: false }). */
export async function setPrefs(prefs: Record<string, boolean>): Promise<PushDeviceView | null> {
  const sub = await currentSubscription();
  if (!sub) return null;
  const { device } = await call<{ device: PushDeviceView }>('PATCH', '/prefs', {
    endpoint: sub.endpoint,
    prefs,
  });
  if ('enabled' in prefs) await syncBadge();
  return device;
}

/** Sends a test notification to this device. */
export async function sendTest(): Promise<void> {
  const sub = await currentSubscription();
  if (!sub) throw new Error(PUSH_TEXT.notOn);
  await call('POST', '/test', { endpoint: sub.endpoint });
}

/** Sets the app-icon badge (0 clears it). Does nothing where badges aren't supported. */
export async function setBadge(n: number): Promise<void> {
  const nav = navigator as Navigator & {
    setAppBadge?: (n?: number) => Promise<void>;
    clearAppBadge?: () => Promise<void>;
  };
  try {
    if (n > 0) await nav.setAppBadge?.(n);
    else await nav.clearAppBadge?.();
  } catch {
    /* No permission for badges: nothing to do. */
  }
}

let syncing: Promise<void> | null = null;
let again = false;
/**
 * Puts the server's count on the app icon: call it when the app opens and whenever the data
 * behind the count changes. Clears it when notifications are off on this device.
 */
export function syncBadge(): Promise<void> {
  if (!('setAppBadge' in navigator)) return Promise.resolve();
  if (syncing) {
    again = true;
    return syncing;
  }
  syncing = (async () => {
    try {
      const sub = await currentSubscription();
      if (!sub || Notification.permission !== 'granted') return setBadge(0);
      const { count } = await call<{ count: number }>('POST', '/badge', {
        endpoint: sub.endpoint,
      });
      await setBadge(count);
    } catch {
      /* Offline: try next time. */
    } finally {
      syncing = null;
      if (again) {
        again = false;
        void syncBadge();
      }
    }
  })();
  return syncing;
}

/**
 * A tapped notification, when the app is already open: route to its URL in-app (the service
 * worker focuses the window and posts it here). Without a handler, the page navigates.
 */
export function onPushOpen(go?: (url: string) => void): () => void {
  if (!('serviceWorker' in navigator)) return () => undefined;
  const on = (e: MessageEvent) => {
    const d = e.data as { type?: string; url?: string } | null;
    if (d?.type !== 'kit-push-open' || typeof d.url !== 'string' || !d.url.startsWith('/')) return;
    if (go) go(d.url);
    else window.location.assign(d.url);
    void syncBadge();
  };
  navigator.serviceWorker.addEventListener('message', on);
  navigator.serviceWorker.startMessages?.();
  return () => navigator.serviceWorker.removeEventListener('message', on);
}

/**
 * What stops notifications on this device, or null when they can work. `install`: the fix is
 * installing the app (iOS in a browser tab, or no push here): show PUSH_TEXT.needsInstall, a
 * link to the app's "Install on your phone" section, and installSteps() behind an ⓘ.
 */
export function pushBlocker(
  s: PushState,
  title: string,
): { text: string; install: boolean } | null {
  if (s.needsInstall || !s.supported) return { text: PUSH_TEXT.needsInstall(title), install: true };
  if (s.permission === 'denied') return { text: PUSH_TEXT.blocked, install: false };
  return null;
}

/** The words in Settings → Notifications, the same in every app. Hints are one short line. */
export const PUSH_TEXT = {
  heading: 'Notifications',
  master: 'Notifications on this device',
  test: 'Send a test',
  testSent: 'Sent. It should arrive in a few seconds.',
  about: 'About notifications',
  /** The one visible line when the app isn't installed (iOS in Safari, or no push here). */
  needsInstall: (title: string) => `Notifications need ${title} installed on your phone.`,
  /** Link or button to the app's "Install on your phone" section. */
  installLink: 'Install on your phone',
  howToInstall: 'How to install',
  /** The ⓘ on the master switch once installed. */
  whyItWorks: 'Why it works here',
  installed: (title: string) =>
    `Notifications work here because ${title} is installed on this device.`,
  unsupported: 'This browser can’t show notifications.',
  blocked: 'Notifications are blocked. Allow them in this device’s settings.',
  noWorker: 'Notifications need the app to finish loading. Reload and try again.',
  notOn: 'Turn on notifications on this device first.',
};

/** Installing the app, for the ⓘ beside PUSH_TEXT.needsInstall (and the README). */
export const installSteps = (title: string) => [
  {
    label: 'iPhone and iPad',
    steps: [
      'In Safari, tap Share.',
      'Tap “Add to Home Screen”, then Add.',
      `Open ${title} from the Home Screen icon and come back here.`,
    ],
  },
  {
    label: 'Android',
    steps: [
      'In Chrome, open the menu ⋮.',
      'Tap “Install app” or “Add to Home screen”.',
      `Open ${title} from the new icon and come back here.`,
    ],
  },
];

/** The ⓘ beside Notifications. `badge`: what the app-icon count counts, if the app has one. */
export const pushInfo = (o: { badge?: string } = {}) => ({
  lines: [
    'Each device chooses its own notifications, so every family member’s phone can pick what it gets.',
    'Daily ones arrive around 8 a.m. in the device’s time zone.',
    ...(o.badge ? [`The app icon shows ${o.badge}.`] : []),
    'They need the app installed on the phone (on iPhone and iPad, added to the Home Screen; iOS 16.4 or later).',
  ],
});
