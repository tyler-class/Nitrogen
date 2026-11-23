// Selfhost Kit: tests for push devices the push service stops accepting, and replacing a
// browser's old entry. Synced from tyler-class/tally (kit/test/push.test.ts). Edit it
// there, not here.
import { env } from 'cloudflare:workers';
import { describe, expect, it } from 'vitest';
import {
  b64url,
  findDevice,
  listDevices,
  pushRoutes,
  runPushJob,
  saveDevice,
  sendPush,
} from '../../../src/worker/kit/push';

/** A browser's subscription keys: a P-256 public key and a 16-byte auth secret. */
async function browserKeys() {
  const pair = (await crypto.subtle.generateKey({ name: 'ECDH', namedCurve: 'P-256' }, true, [
    'deriveBits',
  ])) as CryptoKeyPair;
  const raw = (await crypto.subtle.exportKey('raw', pair.publicKey)) as ArrayBuffer;
  return { p256dh: b64url(raw), auth: b64url(crypto.getRandomValues(new Uint8Array(16))) };
}

const service = (status: number) =>
  (async () => new Response(null, { status })) as unknown as typeof fetch;

let n = 0;
const endpoint = () => `https://push.example.com/kit-test/${Date.now()}-${++n}`;

async function device(prefs: Record<string, boolean> = { enabled: true, news: false }) {
  const e = endpoint();
  const d = await saveDevice(env.DB, {
    subscription: { endpoint: e, keys: await browserKeys() },
    tz: 'UTC',
    prefs: prefs as never,
  });
  return d;
}

function routes(status = 201) {
  const app = pushRoutes({ title: 'Kit', kinds: ['news'], fetcher: service(status) });
  const call = async (method: string, path: string, body: unknown) => {
    const r = await app.request(
      path,
      { method, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) },
      env,
    );
    return { status: r.status, data: (await r.json()) as Record<string, unknown> };
  };
  return call;
}

describe('kit push: stopped devices', () => {
  it('marks a device the push service turns away as stopped, keeping its choices', async () => {
    const d = await device();
    const msg = { title: 'Hi', body: 'There', url: '/' };
    expect(await sendPush(env.DB, d, msg, { fetcher: service(410) })).toBe('gone');
    const after = await findDevice(env.DB, d.endpoint);
    expect(after?.gone_at).toBeTruthy();
    expect(after?.prefs).toMatchObject({ enabled: true, news: false });
    // Nothing more goes to it.
    expect((await listDevices(env.DB)).some((x) => x.id === d.id)).toBe(false);
  });

  it('answers gone for the test and the device, and a new subscription replaces it', async () => {
    const call = routes(404);
    const d = await device();
    const t = await call('POST', '/push/test', { endpoint: d.endpoint });
    expect(t).toMatchObject({ status: 410, data: { error: 'gone' } });
    expect((await call('POST', '/push/device', { endpoint: d.endpoint })).data).toMatchObject({
      device: { gone: true, prefs: { enabled: true, news: false } },
    });
    expect((await call('POST', '/push/badge', { endpoint: d.endpoint })).data).toMatchObject({
      gone: true,
    });

    // The browser subscribes afresh and names its old endpoint: one entry, not two.
    const fresh = endpoint();
    const s = await call('POST', '/push/subscribe', {
      subscription: { endpoint: fresh, keys: await browserKeys() },
      prefs: { enabled: true, news: false },
      replaces: [d.endpoint, null, fresh],
    });
    expect(s).toMatchObject({ status: 200, data: { device: { gone: false } } });
    expect(await findDevice(env.DB, d.endpoint)).toBeNull();
    expect((await findDevice(env.DB, fresh))?.prefs.news).toBe(false);
  });

  it('revives a stopped device that subscribes again with the same endpoint', async () => {
    const d = await device();
    await sendPush(env.DB, d, { title: 'a', body: 'b', url: '/' }, { fetcher: service(410) });
    await saveDevice(env.DB, {
      subscription: { endpoint: d.endpoint, keys: await browserKeys() },
    });
    expect((await findDevice(env.DB, d.endpoint))?.gone_at).toBeNull();
  });

  it('clears out devices stopped for over 30 days', async () => {
    const d = await device();
    const then = new Date('2027-01-01T12:00Z');
    await sendPush(
      env.DB,
      d,
      { title: 'a', body: 'b', url: '/' },
      {
        fetcher: service(410),
        now: then.getTime(),
      },
    );
    const build = () => [];
    await runPushJob(env.DB, { build, now: new Date('2027-01-20T12:00Z') });
    expect(await findDevice(env.DB, d.endpoint)).not.toBeNull();
    await runPushJob(env.DB, { build, now: new Date('2027-02-05T12:00Z') });
    expect(await findDevice(env.DB, d.endpoint)).toBeNull();
  });
});
