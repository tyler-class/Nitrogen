// Selfhost Kit: tests for the anonymous check-in's guards and the on/off message.
// Synced from tyler-class/selfhost-kit (kit/test/telemetry.test.ts). Edit it there, not here.
import { env } from 'cloudflare:workers';
import { beforeEach, describe, expect, it } from 'vitest';
import {
  checkIn,
  checkInOnRequest,
  kitState,
  resetTelemetryMemo,
  setKitState,
  type CheckInOptions,
} from '../../../src/worker/kit/telemetry';

const real = { updatesOn: false, source: false, real: true };

function recorder() {
  const sent: { url: string; body: Record<string, unknown> }[] = [];
  const fetcher = (async (url: string, init: RequestInit) => {
    sent.push({ url, body: JSON.parse(String(init.body)) as Record<string, unknown> });
    return new Response('{"ok":true}');
  }) as unknown as typeof fetch;
  return { sent, fetcher };
}

/** checkInOnRequest with a fake ctx; resolves once its background work is done. */
async function request(url: string, o: CheckInOptions) {
  const jobs: Promise<unknown>[] = [];
  checkInOnRequest({ waitUntil: (p) => jobs.push(p) }, new Request(url), env.DB, o);
  await Promise.all(jobs);
  return jobs.length;
}

beforeEach(async () => {
  resetTelemetryMemo();
  await kitState(env.DB); // makes the table
  await env.DB.prepare('DELETE FROM selfhost_kit').run();
});

describe('kit telemetry guards', () => {
  it('never checks in from tests or from a copy that has only run locally', async () => {
    const { sent, fetcher } = recorder();
    const now = new Date('2027-01-01T05:00:00Z');
    const opts = { app: 'kit', version: '1.0.0', tables: [], fetcher, now };
    // Not a real build (tests): never, from the cron or a request.
    expect(await checkIn(env.DB, opts)).toBe('not-live');
    expect(await request('https://copy.example.com/api/x', opts)).toBe(0);
    // A real build, but only ever reached locally (vite dev, wrangler dev, its cron).
    const live = { ...opts, build: real };
    expect(await checkIn(env.DB, live)).toBe('not-live');
    for (const host of ['localhost:5173', '127.0.0.1:8787', '192.168.1.20:5199', 'duffel.test'])
      expect(await request(`http://${host}/api/x`, live)).toBe(0);
    expect(await checkIn(env.DB, live)).toBe('not-live');
    expect((await kitState(env.DB)).site).toBeNull();
    expect(sent).toHaveLength(0);
  });

  it('checks in once a day after serving a real address, from a request or the cron', async () => {
    const { sent, fetcher } = recorder();
    const day1 = new Date('2027-01-01T05:00:00Z');
    const opts = { app: 'kit', version: '1.0.0', tables: [], fetcher, build: real, now: day1 };
    await request('https://copy.example.com/api/x', opts);
    expect((await kitState(env.DB)).site).toEqual({
      origin: 'https://copy.example.com',
      app: 'kit',
      version: '1.0.0',
    });
    expect(sent.map((s) => s.url)).toEqual(['https://tally.tylerclass.net/v1/checkin']);
    // The cron the same day: already done. The next day: it sends.
    expect(await checkIn(env.DB, opts)).toBe('already');
    expect(await request('https://copy.example.com/api/y', opts)).toBe(0);
    expect(await checkIn(env.DB, { ...opts, now: new Date('2027-01-02T05:00:00Z') })).toBe('sent');
    expect(sent).toHaveLength(2);
  });
});

describe('kit telemetry on/off message', () => {
  it('sends one small message when switched off, nothing after, and one when back on', async () => {
    const { sent, fetcher } = recorder();
    const now = new Date('2027-01-01T05:00:00Z');
    const opts = { app: 'kit', version: '2.3.4', tables: [], fetcher, build: real, now };
    await request('https://copy.example.com/api/x', opts);
    sent.length = 0;
    const id = (await kitState(env.DB)).install_id;

    await setKitState(env.DB, { telemetry: false }, { fetcher, now });
    expect(sent).toEqual([
      {
        url: 'https://tally.tylerclass.net/v1/event',
        body: {
          app: 'kit',
          install: id,
          version: '2.3.4',
          event: 'telemetry_off',
          at: '2027-01-01T05:00:00.000Z',
        },
      },
    ]);
    // Off: no check-ins, and saving it off again sends nothing.
    const day2 = new Date('2027-01-02T05:00:00Z');
    expect(await checkIn(env.DB, { ...opts, now: day2 })).toBe('off');
    await setKitState(env.DB, { telemetry: false, updates_set_up: true }, { fetcher, now: day2 });
    expect(sent).toHaveLength(1);

    await setKitState(env.DB, { telemetry: true }, { fetcher, now: day2 });
    expect(sent[1]?.body).toMatchObject({ event: 'telemetry_on', install: id });
    // The daily check-in resumes right away.
    await request('https://copy.example.com/api/z', { ...opts, now: day2 });
    expect(sent.map((s) => s.url.split('/').at(-1))).toEqual(['event', 'event', 'checkin']);
  });

  it('sends nothing from a copy that has never been live (tests, local dev)', async () => {
    const { sent, fetcher } = recorder();
    await setKitState(env.DB, { telemetry: false }, { fetcher });
    await setKitState(env.DB, { telemetry: true }, { fetcher });
    expect(sent).toHaveLength(0);
    expect((await kitState(env.DB)).telemetry).toBe(true);
  });
});
