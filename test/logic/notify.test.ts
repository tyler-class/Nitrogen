import { describe, expect, it } from 'vitest';
import { extractItems } from '@shared/items';
import {
  badgeCount,
  digestNotice,
  dueToday,
  listUpTo,
  NOTIFY_KINDS,
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
  it('has one switch', () => {
    expect(NOTIFY_KINDS.map((k) => k.id)).toEqual(['digest']);
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
