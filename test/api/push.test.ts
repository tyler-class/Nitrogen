// Push notifications in workerd: the Selfhost Kit's crypto (RFC 8291 / RFC 8292), its timing and
// once-a-day log, the /api/push routes, and Nitrogen's morning digest and badge end to end.
import { env, SELF } from 'cloudflare:test';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  atOrAfterLocalHour,
  b64url,
  encryptPayload,
  fromB64url,
  listDevices,
  localDate,
  runPushJob,
  saveDevice,
  vapidAuth,
  vapidKeys,
  type PushDevice,
} from '../../src/worker/kit/push';
import { nitrogenPush, runNotifications } from '../../src/worker/notifications';
import type { Page } from '../../src/shared/types';
import { ORIGIN, session } from './helpers';

const txt = new TextDecoder();
const u8 = (s: string) => new Uint8Array(new TextEncoder().encode(s));

// ---- A receiving browser: its keys, and decrypting what it's sent (RFC 8291 §3) ----

async function browser() {
  const pair = (await crypto.subtle.generateKey({ name: 'ECDH', namedCurve: 'P-256' }, true, [
    'deriveBits',
  ])) as CryptoKeyPair;
  const pub = new Uint8Array((await crypto.subtle.exportKey('raw', pair.publicKey)) as ArrayBuffer);
  const auth = crypto.getRandomValues(new Uint8Array(16));
  return { pair, p256dh: b64url(pub), auth: b64url(auth) };
}

async function hkdf(salt: Uint8Array, ikm: Uint8Array, info: Uint8Array, n: number) {
  const k = await crypto.subtle.importKey('raw', ikm as BufferSource, 'HKDF', false, [
    'deriveBits',
  ]);
  return new Uint8Array(
    await crypto.subtle.deriveBits(
      { name: 'HKDF', hash: 'SHA-256', salt: salt as BufferSource, info: info as BufferSource },
      k,
      n * 8,
    ),
  );
}

async function decrypt(b: Awaited<ReturnType<typeof browser>>, body: Uint8Array) {
  const salt = body.slice(0, 16);
  const rs = new DataView(body.buffer, body.byteOffset).getUint32(16);
  expect(rs).toBe(4096);
  const idlen = body[20]!;
  const asPublic = body.slice(21, 21 + idlen);
  const asKey = await crypto.subtle.importKey(
    'raw',
    asPublic,
    { name: 'ECDH', namedCurve: 'P-256' },
    false,
    [],
  );
  const ecdh = new Uint8Array(
    await crypto.subtle.deriveBits(
      { name: 'ECDH', public: asKey } as unknown as Parameters<SubtleCrypto['deriveBits']>[0],
      b.pair.privateKey,
      256,
    ),
  );
  const ua = fromB64url(b.p256dh);
  const info = new Uint8Array([...u8('WebPush: info\0'), ...ua, ...asPublic]);
  const ikm = await hkdf(fromB64url(b.auth), ecdh, info, 32);
  const cek = await hkdf(salt, ikm, u8('Content-Encoding: aes128gcm\0'), 16);
  const nonce = await hkdf(salt, ikm, u8('Content-Encoding: nonce\0'), 12);
  const key = await crypto.subtle.importKey('raw', cek, 'AES-GCM', false, ['decrypt']);
  const plain = new Uint8Array(
    await crypto.subtle.decrypt({ name: 'AES-GCM', iv: nonce }, key, body.slice(21 + idlen)),
  );
  expect(plain[plain.length - 1]).toBe(2); // last-record delimiter
  return JSON.parse(txt.decode(plain.slice(0, -1))) as Record<string, unknown>;
}

/** A fake push service: records each request, answers with `status`. */
function pushService(status = 201) {
  const got: { url: string; headers: Headers; body: Uint8Array }[] = [];
  const fetcher = (async (url: string, init: RequestInit) => {
    got.push({
      url: String(url),
      headers: new Headers(init.headers),
      body: new Uint8Array(init.body as Uint8Array),
    });
    return new Response(null, { status });
  }) as unknown as typeof fetch;
  return { got, fetcher };
}

async function device(tz: string, prefs: Record<string, boolean> = {}) {
  const b = await browser();
  const d = await saveDevice(env.DB, {
    subscription: {
      endpoint: `https://push.example.test/${crypto.randomUUID()}`,
      keys: { p256dh: b.p256dh, auth: b.auth },
    },
    tz,
    prefs: { enabled: true, ...prefs },
  });
  return { b, d };
}

/** Only the morning digest, for the digest tests. */
const DIGEST_ONLY = { overdue: false, timed: false, assistant: false, questions: false };

async function clearDevices() {
  for (const d of await listDevices(env.DB))
    await env.DB.prepare('DELETE FROM selfhost_push_devices WHERE id = ?').bind(d.id).run();
  await env.DB.prepare('DELETE FROM selfhost_push_sent').run();
}

afterEach(() => vi.restoreAllMocks());

describe('RFC 8291 payload encryption', () => {
  it('matches the RFC 8291 Appendix A example byte for byte', async () => {
    const body = await encryptPayload(
      u8('When I grow up, I want to be a watermelon'),
      'BCVxsr7N_eNgVRqvHtD0zTZsEc6-VV-JvLexhqUzORcxaOzi6-AYWXvTBHm4bjyPjs7Vd8pZGH6SRpkNtoIAiw4',
      'BTBZMqHH6r4Tts7J_aSIgg',
      {
        senderPrivate: fromB64url('yfWPiYE-n46HLnH0KqZOF1fJJU3MYrct3AELtAQ-oRw'),
        senderPublic: fromB64url(
          'BP4z9KsN6nGRTbVYI_c7VJSPQTBtkgcy27mlmlMoZIIgDll6e3vCYLocInmYWAmS6TlzAC8wEqKK6PBru3jl7A8',
        ),
        salt: fromB64url('DGv6ra1nlYgDCS1FRnbzlw'),
      },
    );
    expect(b64url(body)).toBe(
      'DGv6ra1nlYgDCS1FRnbzlwAAEABBBP4z9KsN6nGRTbVYI_c7VJSPQTBtkgcy27ml' +
        'mlMoZIIgDll6e3vCYLocInmYWAmS6TlzAC8wEqKK6PBru3jl7A_yl95bQpu6cVPT' +
        'pK4Mqgkf1CXztLVBSt2Ks3oZwbuwXPXLWyouBWLVWGNWQexSgSxsj_Qulcy4a-fN',
    );
  });

  it('round-trips with fresh keys, and a browser can decrypt it', async () => {
    const b = await browser();
    const body = await encryptPayload(u8('{"title":"Hi"}'), b.p256dh, b.auth);
    expect(await decrypt(b, body)).toEqual({ title: 'Hi' });
  });

  it('rejects bad keys', async () => {
    await expect(encryptPayload(u8('x'), b64url(new Uint8Array(10)), 'AAAA')).rejects.toThrow();
  });
});

describe('VAPID (RFC 8292)', () => {
  it('makes keys once, stores them, and signs a JWT the public key verifies', async () => {
    const keys = await vapidKeys(env.DB);
    expect(await vapidKeys(env.DB)).toEqual(keys);
    expect(fromB64url(keys.publicKey)).toHaveLength(65);

    const now = Date.UTC(2027, 0, 1, 12);
    const header = await vapidAuth(
      keys,
      'https://web.push.apple.com/abc/def',
      'https://nitrogen.example.com',
      now,
    );
    const m = /^vapid t=([^,]+), k=(.+)$/.exec(header)!;
    expect(m[2]).toBe(keys.publicKey);
    const [h, c, s] = m[1]!.split('.');
    expect(JSON.parse(txt.decode(fromB64url(h!)))).toEqual({ typ: 'JWT', alg: 'ES256' });
    expect(JSON.parse(txt.decode(fromB64url(c!)))).toEqual({
      aud: 'https://web.push.apple.com',
      exp: now / 1000 + 12 * 3600,
      sub: 'https://nitrogen.example.com',
    });
    const pub = await crypto.subtle.importKey(
      'raw',
      fromB64url(keys.publicKey),
      { name: 'ECDSA', namedCurve: 'P-256' },
      false,
      ['verify'],
    );
    const sig = fromB64url(s!);
    expect(sig).toHaveLength(64);
    expect(
      await crypto.subtle.verify({ name: 'ECDSA', hash: 'SHA-256' }, pub, sig, u8(`${h}.${c}`)),
    ).toBe(true);
  });
});

describe('local time', () => {
  const at = (iso: string) => new Date(iso);
  it('8 a.m. in each zone, across DST changes', () => {
    const NY = 'America/New_York';
    // 2027-03-14: clocks go forward in New York (EST → EDT).
    expect(atOrAfterLocalHour(at('2027-03-13T12:59Z'), NY, 8)).toBe(false); // 7:59 EST
    expect(atOrAfterLocalHour(at('2027-03-13T13:00Z'), NY, 8)).toBe(true); // 8:00 EST
    expect(atOrAfterLocalHour(at('2027-03-14T11:59Z'), NY, 8)).toBe(false); // 7:59 EDT
    expect(atOrAfterLocalHour(at('2027-03-14T12:00Z'), NY, 8)).toBe(true); // 8:00 EDT
    // 2027-10-31: clocks go back in London (BST → GMT).
    const LON = 'Europe/London';
    expect(atOrAfterLocalHour(at('2027-10-30T07:00Z'), LON, 8)).toBe(true); // 8:00 BST
    expect(atOrAfterLocalHour(at('2027-10-31T07:41Z'), LON, 8)).toBe(false); // 7:41 GMT
    expect(atOrAfterLocalHour(at('2027-10-31T08:41Z'), LON, 8)).toBe(true);
    // Half-hour zones: the :41 cron is 8:11 in India.
    expect(atOrAfterLocalHour(at('2027-06-01T02:41Z'), 'Asia/Kolkata', 8)).toBe(true);
    expect(atOrAfterLocalHour(at('2027-06-01T02:00Z'), 'Asia/Kolkata', 8)).toBe(false);
    // Not after `until`.
    expect(atOrAfterLocalHour(at('2027-06-01T21:30Z'), 'UTC', 8, 21)).toBe(false);
  });
  it('the local date, which can differ from UTC', () => {
    expect(localDate(at('2027-06-01T20:00Z'), 'Pacific/Auckland')).toBe('2027-06-02');
    expect(localDate(at('2027-06-01T02:00Z'), 'America/Los_Angeles')).toBe('2027-05-31');
    expect(localDate(at('2027-06-01T02:00Z'), 'Not/AZone')).toBe('2027-06-01'); // falls back to UTC
  });
});

describe('the notification run', () => {
  it('sends on the first hourly run at or after 8 a.m. local, once a day, in every zone', async () => {
    await clearDevices();
    const zones = [
      'America/New_York',
      'Europe/London',
      'Asia/Kolkata',
      'Pacific/Auckland',
      'America/Los_Angeles',
    ];
    for (const tz of zones) await device(tz);
    const sentAt: Record<string, string[]> = {};
    const svc = pushService();
    // Two days of the :41 cron, across New York's spring-forward night.
    for (let h = 0; h < 48; h++) {
      const now = new Date(Date.UTC(2027, 2, 13, h, 41));
      await runPushJob(env.DB, {
        now,
        fetcher: svc.fetcher,
        build: (d) => [
          { kind: 'daily', key: 'today', message: { title: 'x', body: d.tz, url: '/' } },
        ],
      });
      for (const r of svc.got.splice(0)) {
        const d = (await listDevices(env.DB)).find((x) => x.endpoint === r.url)!;
        (sentAt[d.tz] ??= []).push(
          new Intl.DateTimeFormat('en-GB', {
            timeZone: d.tz,
            dateStyle: 'short',
            timeStyle: 'short',
          }).format(now),
        );
      }
    }
    // The run starts at 00:41 UTC on the 13th, which is already past 8 a.m. on the 12th in the
    // Americas and mid-afternoon on the 13th in Auckland: those days get one late send too.
    expect(sentAt).toEqual({
      'America/New_York': ['12/03/2027, 19:41', '13/03/2027, 08:41', '14/03/2027, 08:41'],
      'Europe/London': ['13/03/2027, 08:41', '14/03/2027, 08:41'],
      'Asia/Kolkata': ['13/03/2027, 08:11', '14/03/2027, 08:11'],
      'Pacific/Auckland': ['13/03/2027, 13:41', '14/03/2027, 08:41', '15/03/2027, 08:41'],
      'America/Los_Angeles': ['12/03/2027, 16:41', '13/03/2027, 08:41', '14/03/2027, 08:41'],
    });
  });

  it('skips switched-off kinds and devices, retries failures, and drops gone devices', async () => {
    await clearDevices();
    const on = await device('UTC', { a: true, b: false });
    await device('UTC', { enabled: false });
    const build = () => [
      { kind: 'a', key: 'k', message: { title: 'A', body: '', url: '/' } },
      { kind: 'b', key: 'k', message: { title: 'B', body: '', url: '/' } },
    ];
    const now = new Date('2027-06-01T09:41Z');
    const failing = pushService(500);
    expect(await runPushJob(env.DB, { now, build, fetcher: failing.fetcher })).toEqual({
      sent: 0,
      failed: 1,
      gone: 0,
    });
    const ok = pushService();
    const r = await runPushJob(env.DB, { now, build, fetcher: ok.fetcher, badge: () => 4 });
    expect(r).toEqual({ sent: 1, failed: 0, gone: 0 });
    expect(await decrypt(on.b, ok.got[0]!.body)).toMatchObject({ title: 'A', badge: 4 });
    expect(ok.got[0]!.headers.get('Content-Encoding')).toBe('aes128gcm');
    expect(ok.got[0]!.headers.get('TTL')).toBe('86400');
    expect(ok.got[0]!.headers.get('Authorization')).toMatch(/^vapid t=.+, k=/);
    // Already sent today.
    expect((await runPushJob(env.DB, { now, build, fetcher: ok.fetcher })).sent).toBe(0);
    // The next day, the push service says the subscription is gone: the device goes.
    const gone = pushService(410);
    const next = new Date('2027-06-02T09:41Z');
    expect((await runPushJob(env.DB, { now: next, build, fetcher: gone.fetcher })).gone).toBe(1);
    expect((await listDevices(env.DB)).map((d) => d.prefs.enabled)).toEqual([false]);
  });

  it('sends Nitrogen’s morning digest with the due badge, by each device’s own date', async () => {
    await clearDevices();
    const api = await session();
    const plans = (
      await api.post<Page>('/pages', {
        title: 'Push test plans',
        parent_id: null,
        body: [
          '- [ ] todo: Send the draft due:2031-06-03',
          '- [ ] reminder: Renew the domain due:2031-06-03',
          '- [ ] todo: Book the room due:2031-06-01',
          '- [x] todo: Done already due:2031-06-03',
          '- [ ] todo: Pay the invoice due:2031-06-02',
          '- [ ] question: Which vendor? due:2031-06-01',
          '- [ ] todo: Later due:2031-06-20',
        ].join('\n'),
      })
    ).data;
    // Auckland reaches 8 a.m. on the 3rd while Los Angeles is still on the 2nd.
    const akl = await device('Pacific/Auckland', DIGEST_ONLY);
    const la = await device('America/Los_Angeles', DIGEST_ONLY);
    const svc = pushService();
    // 7:41 in Auckland (NZST), 12:41 the day before in Los Angeles.
    await runNotifications(env.DB, { now: new Date('2031-06-02T19:41Z'), fetcher: svc.fetcher });
    const first = svc.got.splice(0);
    expect(first.map((r) => r.url)).toEqual([la.d.endpoint]);
    expect(await decrypt(la.b, first[0]!.body)).toEqual({
      title: 'Due today',
      body: '1 to-do: Pay the invoice',
      url: `/p/${plans.id}/push-test-plans#item-5`,
      tag: 'digest-today',
      icon: '/icons/icon-192.png',
      badge: 2,
    });
    // 8:41 in Auckland on the 3rd.
    await runNotifications(env.DB, { now: new Date('2031-06-02T20:41Z'), fetcher: svc.fetcher });
    const second = svc.got.splice(0);
    expect(second.map((r) => r.url)).toEqual([akl.d.endpoint]);
    expect(await decrypt(akl.b, second[0]!.body)).toEqual({
      title: 'Due today',
      body: '1 to-do and 1 reminder: Send the draft, Renew the domain',
      url: `/p/${plans.id}/push-test-plans`,
      tag: 'digest-today',
      icon: '/icons/icon-192.png',
      badge: 4,
    });
    // Once a day: later runs that day send nothing more.
    await runNotifications(env.DB, { now: new Date('2031-06-03T02:11Z'), fetcher: svc.fetcher });
    expect(svc.got).toHaveLength(0);
    // Next day: nothing is due on the 4th in Auckland, and Los Angeles (where the 3rd has two)
    // has switched the digest off.
    await api.patch('/push/prefs', { endpoint: la.d.endpoint, prefs: { digest: false } });
    await runNotifications(env.DB, { now: new Date('2031-06-03T20:41Z'), fetcher: svc.fetcher });
    expect(svc.got).toHaveLength(0);
    // Ticking an item off lowers the badge.
    const badge = (d: PushDevice) =>
      nitrogenPush(env.DB).badge!(d, new Date('2031-06-02T20:41Z'), env.DB);
    expect(await badge(akl.d)).toBe(4);
    await api.post(`/pages/${plans.id}/items/toggle`, { line: 3, done: true });
    expect(await badge(akl.d)).toBe(3);
    await api.del(`/pages/${plans.id}`);
  });

  it('sends today’s digest to a device turned on late in the evening, but nothing before 8', async () => {
    await clearDevices();
    const api = await session();
    const plans = (
      await api.post<Page>('/pages', {
        title: 'Late push plans',
        parent_id: null,
        body: '- [ ] todo: File the report due:2031-07-08',
      })
    ).data;
    const svc = pushService();
    const utc = await device('UTC', DIGEST_ONLY);
    // 7:41 local: too early.
    await runNotifications(env.DB, { now: new Date('2031-07-08T07:41Z'), fetcher: svc.fetcher });
    expect(svc.got).toHaveLength(0);
    // Off all day; turned on at 22:00, it gets the 22:11 run's digest straight away.
    await env.DB.prepare('DELETE FROM selfhost_push_devices WHERE id = ?').bind(utc.d.id).run();
    const late = await device('UTC', DIGEST_ONLY);
    await runNotifications(env.DB, { now: new Date('2031-07-08T22:11Z'), fetcher: svc.fetcher });
    expect(svc.got.map((r) => r.url)).toEqual([late.d.endpoint]);
    expect(await decrypt(late.b, svc.got[0]!.body)).toMatchObject({
      title: 'Due today',
      body: '1 to-do: File the report',
    });
    await api.del(`/pages/${plans.id}`);
  });

  it('sends overdue, timed, open-question and assistant notifications, each once', async () => {
    await clearDevices();
    const api = await session();
    // Monday 2031-09-08 in New York (EDT, UTC−4).
    const plans = (
      await api.post<Page>('/pages', {
        title: 'Kinds plans',
        parent_id: null,
        body: [
          '- [ ] reminder: Renew the domain due:2031-09-07',
          '- [ ] todo: Call the dentist due:2031-09-08 14:00',
          '- [ ] question: Which hosting plan?',
          '- [x] question: Which colour? answer: Blue',
        ].join('\n'),
      })
    ).data;
    const ny = await device('America/New_York', { digest: false });
    const svc = pushService();
    const run = async (iso: string) => {
      await runNotifications(env.DB, { now: new Date(iso), fetcher: svc.fetcher });
      return Promise.all(svc.got.splice(0).map((r) => decrypt(ny.b, r.body)));
    };
    // 7:50 a.m.: nothing yet.
    expect(await run('2031-09-08T11:50Z')).toEqual([]);
    // 8:05 a.m.: the overdue reminder and the week's open questions.
    const morning = await run('2031-09-08T12:05Z');
    expect(morning.map((m) => [m.title, m.body, m.url])).toEqual([
      ['Overdue', 'Renew the domain (due Sep 7)', `/p/${plans.id}/kinds-plans#item-1`],
      ['Open questions', '1 open question: Which hosting plan?', '/?items=question'],
    ]);
    expect(await run('2031-09-08T12:20Z')).toEqual([]);
    // 1:50 p.m.: still 10 minutes early. 1:53: the run nearest 2:00 sends it, once.
    expect(await run('2031-09-08T17:50Z')).toEqual([]);
    const timed = await run('2031-09-08T17:53Z');
    expect(timed).toMatchObject([
      {
        title: 'To-do',
        body: 'Call the dentist (2:00 PM)',
        url: `/p/${plans.id}/kinds-plans#item-2`,
      },
    ]);
    expect(await run('2031-09-08T18:05Z')).toEqual([]);
    // Tuesday: the dentist is overdue now (the domain was only new yesterday); no questions.
    expect((await run('2031-09-09T12:05Z')).map((m) => [m.title, m.body])).toEqual([
      ['Overdue', 'Call the dentist (due Sep 8)'],
    ]);
    expect(await run('2031-09-10T12:05Z')).toEqual([]);

    // An assistant's edits at 3:10 p.m., and the owner's own: one notification at 4, the
    // assistant's only.
    const { createPage, updatePage } = await import('../../src/worker/pages');
    const { agent, YOU } = await import('../../src/shared/actor');
    vi.useFakeTimers({ now: new Date('2031-09-09T19:10Z'), toFake: ['Date'] });
    const garden = await createPage(
      env.DB,
      { title: 'Garden', parent_id: null, body: 'Tomatoes.' },
      agent('Claude'),
    );
    await updatePage(
      env.DB,
      plans.id,
      { body: `${plans.body}\nMore.` },
      { actor: agent('Claude') },
    );
    await updatePage(env.DB, garden.id, { title: 'Garden' }, { actor: YOU });
    vi.useRealTimers();
    expect(await run('2031-09-09T19:50Z')).toEqual([]);
    const hourly = await run('2031-09-09T20:02Z');
    expect(hourly.map((m) => [m.title, m.body, m.url])).toEqual([
      ['Assistant changes', 'Claude updated 2 pages: Kinds plans, Garden', '/activity'],
    ]);
    expect(await run('2031-09-09T20:17Z')).toEqual([]);
    await api.del(`/pages/${plans.id}`);
    await api.del(`/pages/${garden.id}`);
  });
});

describe('/api/push', () => {
  it('needs a session', async () => {
    const r = await SELF.fetch(`${ORIGIN}/api/push/key`);
    expect(r.status).toBe(401);
    expect(r.status).not.toBe(200);
  });

  it('subscribes this device, keeps its choices, tests, badges and unsubscribes', async () => {
    await clearDevices();
    const api = await session();
    const { data: key } = await api.get<{ key: string }>('/push/key');
    expect(key.key).toBe((await vapidKeys(env.DB)).publicKey);

    const b = await browser();
    const endpoint = `https://push.example.test/${crypto.randomUUID()}`;
    const sub = { endpoint, keys: { p256dh: b.p256dh, auth: b.auth } };
    expect((await api.post('/push/device', { endpoint })).data).toEqual({ device: null });
    expect(
      (await api.post('/push/subscribe', { subscription: { endpoint: 'http://x' } })).status,
    ).toBe(400);
    const s = await api.post<{ device: Pick<PushDevice, 'tz' | 'prefs'> }>('/push/subscribe', {
      subscription: sub,
      tz: 'Europe/Lisbon',
      prefs: { enabled: true, digest: true },
    });
    expect(s.status).toBe(200);
    expect(s.data.device).toMatchObject({
      tz: 'Europe/Lisbon',
      prefs: { enabled: true, digest: true },
    });

    const p = await api.patch<{ device: Pick<PushDevice, 'tz' | 'prefs'> }>('/push/prefs', {
      endpoint,
      prefs: { digest: false, 'bad key!': true, other: 'yes' },
      tz: 'Asia/Tokyo',
    });
    expect(p.data.device).toMatchObject({
      tz: 'Asia/Tokyo',
      prefs: { enabled: true, digest: false },
    });
    expect(Object.keys(p.data.device.prefs)).not.toContain('bad key!');
    // Subscribing again (new keys) keeps the device's choices.
    const again = await api.post<{ device: Pick<PushDevice, 'prefs'> }>('/push/subscribe', {
      subscription: sub,
      prefs: { enabled: true },
    });
    expect(again.data.device.prefs.digest).toBe(false);

    // The test notification goes to the push service, encrypted for this device.
    const sent: { url: string; body: Uint8Array }[] = [];
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
      sent.push({ url: String(input), body: new Uint8Array(init!.body as Uint8Array) });
      return new Response(null, { status: 201 });
    });
    const t = await api.post<{ result: string }>('/push/test', { endpoint });
    expect(t).toEqual({ status: 200, data: { result: 'sent' } });
    expect(sent[0]!.url).toBe(endpoint);
    expect(await decrypt(b, sent[0]!.body)).toMatchObject({
      title: 'Nitrogen notifications are on',
      icon: '/icons/icon-192.png',
      url: '/settings',
      badge: 0,
    });
    vi.restoreAllMocks();

    expect((await api.post('/push/badge', { endpoint })).data).toEqual({ count: 0 });
    expect((await api.post('/push/unsubscribe', { endpoint })).data).toEqual({ ok: true });
    expect((await api.post('/push/device', { endpoint })).data).toEqual({ device: null });
    expect((await api.post('/push/test', { endpoint })).status).toBe(404);
  });
});
