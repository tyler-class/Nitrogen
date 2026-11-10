import { env } from 'cloudflare:test';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { checkIn, kitState, noteSite } from '../../src/worker/kit/telemetry';
import { USAGE_TABLES } from '../../src/worker/index';
import { session } from './helpers';

afterEach(() => {
  vi.restoreAllMocks();
});

describe('anonymous check-in', () => {
  it('sends counts once a day, never contents, and stops when switched off', async () => {
    const api = await session();
    await api.post('/pages', {
      title: 'Secret page title',
      parent_id: null,
      body: 'Private notes',
    });
    await env.FILES.put('kit-test/one.png', 'x');
    await env.FILES.put('kit-test/two.png', 'y');
    const sent: Record<string, unknown>[] = [];
    const fetcher = (async (_url: string, init: RequestInit) => {
      sent.push(JSON.parse(String(init.body)));
      return new Response('{"ok":true}');
    }) as unknown as typeof fetch;
    const opts = {
      build: { updatesOn: false, source: false, real: true },
      app: 'nitrogen',
      version: '1.2.3',
      tables: USAGE_TABLES,
      buckets: [env.FILES],
      fetcher,
    };

    // A live copy (a real build that has served a request at a real address).
    await noteSite(env.DB, {
      origin: 'https://copy.example.com',
      app: 'nitrogen',
      version: '1.2.3',
    });
    // The Settings switch sends its on/off message with the global fetch: catch it here.
    const events: unknown[] = [];
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
      expect(String(input)).toBe('https://tally.tylerclass.net/v1/event');
      events.push((JSON.parse(String(init?.body)) as { event: string }).event);
      return new Response('{"ok":true}');
    });

    const day1 = new Date('2027-01-01T05:00:00Z');
    expect(await checkIn(env.DB, { ...opts, now: day1 })).toBe('sent');
    expect(await checkIn(env.DB, { ...opts, now: day1 })).toBe('already');
    const body = sent[0]!;
    expect(body).toMatchObject({
      app: 'nitrogen',
      version: '1.2.3',
      install: (await kitState(env.DB)).install_id,
      flags: { updates_set_up: false },
    });
    expect((body.rows as Record<string, number>).pages).toBeGreaterThanOrEqual(1);
    expect(body.files).toBeGreaterThanOrEqual(2);
    expect(JSON.stringify(body)).not.toMatch(/Secret|Private|kit-test/);

    // The switch in Settings turns it off.
    await api.patch('/settings', { telemetry: false, updates_set_up: true });
    const s = (await api.get<{ telemetry: boolean; updates_set_up: boolean }>('/settings')).data;
    expect([s.telemetry, s.updates_set_up]).toEqual([false, true]);
    expect(await checkIn(env.DB, { ...opts, now: new Date('2027-01-02T05:00:00Z') })).toBe('off');
    expect(events).toEqual(['telemetry_off']);
    expect(sent).toHaveLength(1);

    // A failed send is tried again on the next run.
    await api.patch('/settings', { telemetry: true });
    const failing = (async () => new Response('', { status: 500 })) as unknown as typeof fetch;
    const day3 = new Date('2027-01-03T05:00:00Z');
    expect(await checkIn(env.DB, { ...opts, fetcher: failing, now: day3 })).toBe('failed');
    expect(await checkIn(env.DB, { ...opts, now: day3 })).toBe('sent');
    expect(events).toEqual(['telemetry_off', 'telemetry_on']);
    // A live copy reports what its build saw, not the Settings click.
    expect(sent[1]).toMatchObject({ flags: { updates_set_up: false, source: false } });
  });
});
