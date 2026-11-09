import { describe, expect, it } from 'vitest';
import { extractItems } from '@shared/items';
import {
  addDays,
  assistantNotice,
  assistantWindow,
  badgeCount,
  digestNotice,
  dueToday,
  fingerprint,
  formatClock,
  formatDay,
  listUpTo,
  localClock,
  newlyOverdue,
  noticesNow,
  NOTIFY_KINDS,
  overdueNotice,
  questionsNotice,
  timedDue,
  timedNotices,
  type DatedItem,
} from '@shared/notify';

/** Items as the index holds them, from markdown on a page. */
function page(id: string, title: string, md: string): DatedItem[] {
  return extractItems(md).map((i) => ({
    page_id: id,
    page_title: title,
    line: i.line,
    type: i.type,
    text: i.text,
    due: i.due,
    due_time: i.due_time,
    done: i.done,
  }));
}

const plans = page(
  'p1',
  'Plans',
  [
    '- [ ] todo: Send the draft to **legal** @maria due:2031-06-03',
    '- [ ] reminder: Renew the domain due:2031-06-03',
    '- [ ] todo: Book the room due:2031-06-01', // overdue
    '- [x] todo: Already done due:2031-06-03',
    '- [ ] todo: Next week due:2031-06-10',
    '- [ ] todo: No date',
    '- [ ] question: Which vendor? due:2031-06-02', // questions don't count
    '```',
    '- [ ] todo: In a code block due:2031-06-03',
    '```',
  ].join('\n'),
);
const home = page('p2', 'Home', '- [ ] todo: Water the [[Garden|plants]] due:2031-06-03');

describe('the badge', () => {
  it('counts open to-dos and reminders due today or earlier', () => {
    expect(badgeCount(plans, '2031-06-03')).toBe(3);
    expect(badgeCount([...plans, ...home], '2031-06-03')).toBe(4);
    expect(badgeCount(plans, '2031-06-02')).toBe(1);
    expect(badgeCount(plans, '2031-05-31')).toBe(0);
    expect(badgeCount(plans, '2031-06-10')).toBe(4);
  });
});

describe('the morning digest', () => {
  it('is one of five switches, each with a one-line description', () => {
    expect(NOTIFY_KINDS.map((k) => k.id)).toEqual([
      'digest',
      'overdue',
      'timed',
      'assistant',
      'questions',
    ]);
    for (const k of NOTIFY_KINDS) {
      expect(k.description.length).toBeLessThan(60);
      expect(k.description).toMatch(/\.$/);
      expect(k.description).not.toMatch(/[.!?]\s+[A-Z]/);
    }
  });

  it('lists only what is due today, by page then line', () => {
    expect(dueToday([...plans, ...home], '2031-06-03').map((i) => i.text)).toEqual([
      'Water the [[Garden|plants]]',
      'Send the draft to **legal**',
      'Renew the domain',
    ]);
    expect(dueToday(plans, '2031-06-02')).toEqual([]);
  });

  it('is skipped when nothing is due today', () => {
    expect(digestNotice(plans, '2031-06-02')).toBeNull();
    expect(digestNotice([], '2031-06-03')).toBeNull();
  });

  it('words and links one page’s items', () => {
    expect(digestNotice(plans, '2031-06-03')).toEqual({
      kind: 'digest',
      key: 'today',
      title: 'Due today',
      body: '1 to-do and 1 reminder: Send the draft to legal, Renew the domain',
      url: '/p/p1/plans',
      tag: 'digest-today',
    });
  });

  it('opens the item when there is one, and Home when they are on several pages', () => {
    expect(digestNotice(home, '2031-06-03')).toMatchObject({
      body: '1 to-do: Water the plants',
      url: '/p/p2/home#item-1',
    });
    expect(digestNotice([...plans, ...home], '2031-06-03')).toMatchObject({
      body: '2 to-dos and 1 reminder: Water the plants, Send the draft to legal, Renew the domain',
      url: '/',
    });
  });

  it('shortens a long list with "…"', () => {
    const many = page(
      'p3',
      'Chores',
      Array.from(
        { length: 20 },
        (_, i) => `- [ ] todo: Chore number ${i + 1} with a longer name due:2031-06-03`,
      ).join('\n'),
    );
    const n = digestNotice(many, '2031-06-03')!;
    expect(n.body.startsWith('20 to-dos: Chore number 1 with a longer name, ')).toBe(true);
    expect(n.body.endsWith(', …')).toBe(true);
    expect(n.body.length).toBeLessThan(180);
    expect(listUpTo(['a', 'b'], ', ', 150)).toBe('a, b');
    expect(listUpTo(['x'.repeat(200)], ', ', 150)).toBe('x'.repeat(200));
  });
});

// ---- The new kinds ----

const at = (iso: string, tz: string) => localClock(new Date(iso), tz);

describe('the device clock', () => {
  it('reads date, minutes and weekday in the device’s zone', () => {
    expect(at('2031-06-02T19:41:30Z', 'Pacific/Auckland')).toEqual({
      date: '2031-06-03',
      minutes: 7 * 60 + 41.5,
      weekday: 2,
    });
    expect(at('2031-06-02T19:41Z', 'America/Los_Angeles')).toMatchObject({
      date: '2031-06-02',
      minutes: 12 * 60 + 41,
      weekday: 1,
    });
    // An unknown zone reads as UTC.
    expect(at('2031-06-02T19:41Z', 'Not/AZone').minutes).toBe(19 * 60 + 41);
  });

  it('adds days across months and years, and formats days and times', () => {
    expect(addDays('2031-03-01', -1)).toBe('2031-02-28');
    expect(addDays('2031-12-31', 1)).toBe('2032-01-01');
    expect(formatDay('2026-11-10')).toBe('Nov 10');
    expect(formatClock('14:00')).toBe('2:00 PM');
    expect(formatClock('00:05')).toBe('12:05 AM');
    expect(formatClock('12:30')).toBe('12:30 PM');
  });
});

describe('overdue nudges', () => {
  const items = page(
    'p1',
    'Plans',
    [
      '- [ ] reminder: Renew the domain due:2026-11-10',
      '- [ ] todo: Pay the bill due:2026-11-10 09:00',
      '- [ ] todo: Older due:2026-11-09',
      '- [x] todo: Done due:2026-11-10',
      '- [ ] question: Asked due:2026-11-10',
      '- [ ] todo: Today due:2026-11-11',
    ].join('\n'),
  );

  it('picks only open to-dos and reminders on their first overdue day', () => {
    expect(newlyOverdue(items, '2026-11-11').map((i) => i.text)).toEqual([
      'Renew the domain',
      'Pay the bill',
    ]);
    expect(newlyOverdue(items, '2026-11-12').map((i) => i.text)).toEqual(['Today']);
    expect(overdueNotice(items, '2026-11-13')).toBeNull();
  });

  it('words one item with its date and opens it', () => {
    expect(overdueNotice(items.slice(0, 1), '2026-11-11')).toEqual({
      kind: 'overdue',
      key: 'first-day',
      title: 'Overdue',
      body: 'Renew the domain (due Nov 10)',
      url: '/p/p1/plans#item-1',
      tag: 'overdue',
    });
  });

  it('makes several one notification that opens Home', () => {
    expect(overdueNotice(items, '2026-11-11')).toMatchObject({
      body: '1 to-do and 1 reminder (due Nov 10): Renew the domain, Pay the bill',
      url: '/',
    });
  });
});

describe('timed items', () => {
  const md = [
    '- [ ] reminder: Call the dentist due:2026-11-12 14:00',
    '- [ ] todo: Stand-up due:2026-11-12T09:15',
    '- [ ] todo: All day due:2026-11-12',
    '- [x] reminder: Done due:2026-11-12 14:00',
    '- [ ] reminder: Late night due:2026-11-12 23:55',
    '- [ ] reminder: Bad due:2026-11-12 25:00',
  ].join('\n');
  const items = page('p1', 'Plans', md);
  const ny = (iso: string) => at(iso, 'America/New_York');

  it('go out at the cron run nearest their time, on the device’s clock', () => {
    // 1:50 p.m. EST is 10 minutes early; 1:53 is the nearest quarter-hour run's window.
    expect(timedNotices(items, ny('2026-11-12T18:50Z'))).toEqual([]);
    const [n] = timedNotices(items, ny('2026-11-12T18:53Z'));
    expect(n).toEqual({
      kind: 'timed',
      key: `p1:2026-11-12T14:00:${n!.key.split(':').pop()}`,
      title: 'Reminder',
      body: 'Call the dentist (2:00 PM)',
      url: '/p/p1/plans#item-1',
      tag: 'timed-p1-1',
    });
    // Still offered for two hours (a missed run, a failed send); the kit sends it once that day.
    expect(timedNotices(items, ny('2026-11-12T20:59Z')).map((x) => x.body)).toEqual([
      'Call the dentist (2:00 PM)',
    ]);
    expect(timedNotices(items, ny('2026-11-12T21:00Z'))).toEqual([]);
    // The same instant in Los Angeles is 11 a.m.: not the dentist yet, but the 9:15 stand-up
    // (still within its two hours).
    expect(
      timedNotices(items, at('2026-11-12T19:00Z', 'America/Los_Angeles')).map((x) => x.body),
    ).toEqual(['Stand-up (9:15 AM)']);
    // A to-do with a time is titled as one.
    expect(timedNotices(items, ny('2026-11-12T14:15Z'))).toMatchObject([
      { title: 'To-do', body: 'Stand-up (9:15 AM)' },
    ]);
  });

  it('skip items without a time, done items, bad times and other days', () => {
    const all = Array.from({ length: 96 }, (_, q) =>
      timedNotices(items, { date: '2026-11-12', minutes: q * 15, weekday: 4 }),
    ).flat();
    expect([...new Set(all.map((n) => n.body))]).toEqual([
      'Stand-up (9:15 AM)',
      'Call the dentist (2:00 PM)',
      'Late night (11:55 PM)',
    ]);
    expect(timedNotices(items, { date: '2026-11-13', minutes: 14 * 60, weekday: 5 })).toEqual([]);
  });

  it('sends a time after the last run of the day at that last run', () => {
    expect(timedDue(items[4]!, { date: '2026-11-12', minutes: 23 * 60 + 45, weekday: 4 })).toBe(
      true,
    );
    expect(timedDue(items[4]!, { date: '2026-11-12', minutes: 23 * 60 + 30, weekday: 4 })).toBe(
      false,
    );
  });

  it('follows DST: a skipped time goes after the jump, a doubled one once (one date)', () => {
    const spring = page('p1', 'Plans', '- [ ] reminder: Water due:2027-03-14 02:30');
    // New York springs forward at 2:00 → 3:00 on 2027-03-14 (06:00Z is 1:00 EST, 07:00Z 3:00 EDT).
    expect(timedNotices(spring, ny('2027-03-14T06:45Z'))).toEqual([]);
    expect(timedNotices(spring, ny('2027-03-14T07:00Z')).map((n) => n.body)).toEqual([
      'Water (2:30 AM)',
    ]);
    const fall = page('p1', 'Plans', '- [ ] reminder: Feed due:2026-11-01 01:30');
    // 1:30 happens twice on 2026-11-01: 05:30Z (EDT) and 06:30Z (EST). Both read as that date,
    // so the key and date match and the kit sends it only the first time.
    const first = timedNotices(fall, ny('2026-11-01T05:30Z'));
    const second = timedNotices(fall, ny('2026-11-01T06:30Z'));
    expect(first.map((n) => n.key)).toEqual(second.map((n) => n.key));
    expect(ny('2026-11-01T05:30Z').date).toBe(ny('2026-11-01T06:30Z').date);
  });

  it('keys on the item, not its line, so moving it doesn’t send it again', () => {
    const moved = page('p1', 'Plans', `Intro\n\n${md}`);
    const now = ny('2026-11-12T19:00Z');
    expect(timedNotices(moved, now)[0]!.key).toBe(timedNotices(items, now)[0]!.key);
    expect(fingerprint('a')).not.toBe(fingerprint('b'));
  });

  it('still count by date for the badge and the digest', () => {
    expect(badgeCount(items, '2026-11-12')).toBe(5);
    expect(digestNotice(items, '2026-11-12')!.body).toBe(
      '2 to-dos and 3 reminders: Call the dentist (2:00 PM), Stand-up (9:15 AM), All day, Late night (11:55 PM), Bad',
    );
  });
});

describe('assistant changes', () => {
  const ev = (
    page_id: string,
    title: string,
    actor: string | null,
    action = 'edit',
    live = true,
  ) => ({
    page_id,
    title,
    action,
    actor,
    live,
  });

  it('cover the hour before each hour, and the night at 8 a.m.', () => {
    const w = assistantWindow(new Date('2026-11-12T19:07Z'), 'America/New_York')!;
    expect([w.from.toISOString(), w.to.toISOString(), w.key]).toEqual([
      '2026-11-12T18:00:00.000Z',
      '2026-11-12T19:00:00.000Z',
      '2026-11-12T19',
    ]);
    // 3 a.m. in New York: quiet.
    expect(assistantWindow(new Date('2026-11-12T08:07Z'), 'America/New_York')).toBeNull();
    // 8 a.m.: everything since 11 p.m. (the last hour that was sent).
    const morning = assistantWindow(new Date('2026-11-12T13:07Z'), 'America/New_York')!;
    expect(morning.from.toISOString()).toBe('2026-11-12T04:00:00.000Z');
    // A half-hour zone whose date changes mid-hour: only the run before midnight sends.
    expect(assistantWindow(new Date('2026-11-12T18:10Z'), 'Asia/Kolkata')).not.toBeNull();
    expect(assistantWindow(new Date('2026-11-12T18:40Z'), 'Asia/Kolkata')).toBeNull();
  });

  const w = assistantWindow(new Date('2026-11-12T19:07Z'), 'UTC')!;

  it('name the assistant and the pages, and ignore the owner’s own edits', () => {
    expect(
      assistantNotice(
        [
          ev('a', 'Trip ideas', 'agent:Claude'),
          ev('b', 'Garden', 'agent:Claude'),
          ev('a', 'Trip ideas', 'agent:Claude'),
          ev('c', 'Mine', 'you'),
          ev('d', 'Old', null),
          ev('e', 'Budget', 'agent:Claude', 'create'),
          ev('f', 'Recipes', 'agent:Claude'),
          ev('g', 'Reading list with a very long title indeed', 'agent:Claude'),
          ev('h', 'Another page with a fairly long title', 'agent:Claude'),
          ev('i', 'And one more page title to go over', 'agent:Claude'),
          ev('j', 'Last', 'agent:Claude'),
        ],
        w,
      ),
    ).toEqual({
      kind: 'assistant',
      key: '2026-11-12T19',
      title: 'Assistant changes',
      body: 'Claude updated 8 pages: Trip ideas, Garden, Budget, Recipes, Reading list with a very long title indeed, Another page with a fairly long title, …',
      url: '/activity',
      tag: 'assistant-changes',
    });
    expect(assistantNotice([ev('c', 'Mine', 'you')], w)).toBeNull();
    expect(assistantNotice([], w)).toBeNull();
  });

  it('open the one page, say "created" for new pages, and "An assistant" without a name', () => {
    expect(assistantNotice([ev('a', 'Trip ideas', 'agent:', 'create')], w)).toMatchObject({
      body: 'An assistant created Trip ideas',
      url: '/p/a/trip-ideas',
    });
    expect(assistantNotice([ev('a', 'Gone', 'agent:Claude', 'delete', false)], w)!.url).toBe(
      '/activity',
    );
    expect(
      assistantNotice([ev('a', 'A', 'agent:Claude'), ev('b', 'B', 'agent:ChatGPT')], w)!.body,
    ).toBe('Claude and ChatGPT updated 2 pages: A, B');
    expect(
      assistantNotice(
        [ev('a', 'A', 'agent:Claude'), ev('b', 'B', 'agent:ChatGPT'), ev('c', 'C', 'agent:Cursor')],
        w,
      )!.body,
    ).toBe('3 assistants updated 3 pages: A, B, C');
  });
});

describe('open questions', () => {
  const items = [
    ...page(
      'p1',
      'Hosting',
      [
        '- question: Which hosting plan?',
        '- [x] question: Which region? answer: EU',
        '- [ ] question: Who pays?',
        '- [ ] todo: Not a question',
      ].join('\n'),
    ),
    ...page('p2', 'Garden', '- question: Raised beds?'),
  ];
  const monday = { date: '2026-11-09', minutes: 8 * 60 + 5, weekday: 1 };

  it('lists unanswered questions on Monday from 8 a.m., linking to Home’s questions', () => {
    expect(questionsNotice(items, monday)).toEqual({
      kind: 'questions',
      key: 'week',
      title: 'Open questions',
      body: '3 open questions: Raised beds?, Which hosting plan?, Who pays?',
      url: '/?items=question',
      tag: 'open-questions',
    });
    expect(questionsNotice(items, { ...monday, minutes: 7 * 60 + 59 })).toBeNull();
    expect(questionsNotice(items, { ...monday, weekday: 2 })).toBeNull();
    expect(questionsNotice(items.slice(1, 2), monday)).toBeNull();
    expect(at('2026-11-09T13:05Z', 'America/New_York').weekday).toBe(1);
  });
});

describe('everything due now', () => {
  it('holds the morning kinds until 8 but sends a timed item at its time', () => {
    const items = page(
      'p1',
      'Plans',
      [
        '- [ ] todo: Early call due:2026-11-09 07:00',
        '- [ ] todo: Later due:2026-11-09',
        '- [ ] todo: Yesterday due:2026-11-08',
        '- question: Open?',
      ].join('\n'),
    );
    const kinds = (minutes: number) =>
      noticesNow(items, { date: '2026-11-09', minutes, weekday: 1 }).map((n) => n.kind);
    expect(kinds(6 * 60 + 50)).toEqual([]);
    expect(kinds(6 * 60 + 55)).toEqual(['timed']);
    expect(kinds(7 * 60 + 59)).toEqual(['timed']);
    expect(kinds(8 * 60)).toEqual(['digest', 'overdue', 'questions', 'timed']);
    const w = assistantWindow(new Date('2026-11-09T19:07Z'), 'UTC')!;
    expect(
      noticesNow(
        [],
        { date: '2026-11-09', minutes: 19 * 60 + 7, weekday: 1 },
        [{ page_id: 'a', title: 'A', action: 'edit', actor: 'agent:Claude', live: true }],
        w,
      ).map((n) => n.body),
    ).toEqual(['Claude updated A']);
  });
});
