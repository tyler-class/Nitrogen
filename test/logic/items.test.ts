import { describe, expect, it } from 'vitest';
import { dueTime, extractItems, parseItemLine, setItemDone, setItemDue } from '@shared/items';

describe('typed items', () => {
  it('parses type, done, owner, due and answer', () => {
    expect(parseItemLine('- [ ] todo: Draft the brief @alex due:2026-11-20', 3)).toMatchObject({
      type: 'todo',
      line: 3,
      text: 'Draft the brief',
      done: false,
      owner: 'alex',
      due: '2026-11-20',
    });
    expect(parseItemLine('- question: Which vendor?', 1)).toMatchObject({
      type: 'question',
      done: false,
    });
    expect(parseItemLine('- [x] question: One marker? answer: Yes, one.', 1)).toMatchObject({
      done: true,
      text: 'One marker?',
      answer: 'Yes, one.',
    });
    expect(parseItemLine('Question: plain line works too', 1)?.type).toBe('question');
    expect(parseItemLine('- [ ] reminder: Renew', 1)?.invalid).toMatch(/due date/);
    expect(parseItemLine('- a todo: not at the start', 1)).toBeNull();
  });

  it('reads an optional time on a due date', () => {
    const p = (l: string) => parseItemLine(l, 1)!;
    expect(p('- [ ] reminder: Call the dentist due:2026-11-12 14:00')).toMatchObject({
      text: 'Call the dentist',
      due: '2026-11-12',
      due_time: '14:00',
    });
    expect(p('- [ ] reminder: Call due:2026-11-12T14:00 @sam')).toMatchObject({
      text: 'Call',
      due: '2026-11-12',
      due_time: '14:00',
      owner: 'sam',
    });
    // One-digit hours are padded; the time can sit mid-line.
    expect(p('- [ ] todo: Stand-up due:2026-11-12 9:05 in room 4')).toMatchObject({
      text: 'Stand-up in room 4',
      due_time: '09:05',
    });
    // No time: as before.
    expect(p('- [ ] todo: Draft due:2026-11-12')).toMatchObject({
      due: '2026-11-12',
      due_time: null,
    });
    expect(p('- [ ] todo: Draft due:2026-11-12 at noon').due_time).toBeNull();
    expect(p('- [ ] todo: Draft due:2026-11-12 at noon').text).toBe('Draft at noon');
    // A bad time keeps the date, drops the time and says why.
    const bad = p('- [ ] reminder: Call due:2026-11-12 25:00');
    expect(bad).toMatchObject({ text: 'Call', due: '2026-11-12', due_time: null });
    expect(bad.invalid).toMatch(/isn’t a time/);
    expect(p('- [ ] reminder: Call due:2026-11-12T14:75').invalid).toMatch(/24-hour/);
    // Not a time at all (seconds, a clock-ish number) stays in the text.
    expect(p('- [ ] todo: Call due:2026-11-12 14:00:30')).toMatchObject({ due_time: null });
    expect(p('- question: Which? due:2026-11-12 10:30').due_time).toBe('10:30');
    expect([
      dueTime('23:59'),
      dueTime('0:00'),
      dueTime('24:00'),
      dueTime('7'),
      dueTime(null),
    ]).toEqual(['23:59', '00:00', null, null, null]);
  });

  it('ignores code and keeps line numbers', () => {
    const md = 'Intro\n\n```\n- todo: in code\n```\n- [ ] todo: real\n';
    expect(extractItems(md).map((i) => [i.line, i.text])).toEqual([[6, 'real']]);
  });

  it('checks items off in place', () => {
    const md = 'a\n- question: Why?\n- [ ] todo: x';
    expect(setItemDone(md, 2, true)).toBe('a\n- [x] question: Why?\n- [ ] todo: x');
    expect(setItemDone(md, 3, true)).toBe('a\n- question: Why?\n- [x] todo: x');
    expect(setItemDone('todo: bare', 1, true)).toBe('- [x] todo: bare');
    expect(setItemDone(md, 1, true)).toBeNull();
  });
});

describe('answers', () => {
  it('answers, edits and clears a question in place', async () => {
    const { setItemAnswer } = await import('@shared/items');
    const md = 'x\n- question: Which vendor? @sam\n- [ ] todo: y';
    const a = setItemAnswer(md, 2, 'Acme')!;
    expect(a).toBe('x\n- [x] question: Which vendor? @sam answer: Acme\n- [ ] todo: y');
    expect(setItemAnswer(a, 2, 'Beta Co')).toBe(
      'x\n- [x] question: Which vendor? @sam answer: Beta Co\n- [ ] todo: y',
    );
    expect(setItemAnswer(a, 2, '  ')).toBe('x\n- [ ] question: Which vendor? @sam\n- [ ] todo: y');
    expect(setItemAnswer(md, 3, 'no')).toBeNull();
  });
});

describe('setItemDue', () => {
  const md = [
    '- [ ] todo: Send the draft @maria due:2026-11-20',
    '- [ ] reminder: Renew the domain due:2026-12-01 09:00',
    '- question: Which vendor?',
    '- [x] todo: Plain',
  ].join('\n');
  const line = (s: string | null, n: number) => s!.split('\n')[n - 1];

  it('changes the date and keeps the owner and checkbox', () => {
    expect(line(setItemDue(md, 1, '2026-11-25'), 1)).toBe(
      '- [ ] todo: Send the draft @maria due:2026-11-25',
    );
    expect(line(setItemDue(md, 4, '2026-11-25', '14:00'), 4)).toBe(
      '- [x] todo: Plain due:2026-11-25 14:00',
    );
  });

  it('sets, changes and drops a time; clears a to-do’s date', () => {
    expect(line(setItemDue(md, 2, '2026-12-02', '9:30'), 2)).toBe(
      '- [ ] reminder: Renew the domain due:2026-12-02 09:30',
    );
    expect(line(setItemDue(md, 2, '2026-12-02'), 2)).toBe(
      '- [ ] reminder: Renew the domain due:2026-12-02',
    );
    expect(line(setItemDue(md, 1, null), 1)).toBe('- [ ] todo: Send the draft @maria');
  });

  it('dates a question too', () => {
    expect(line(setItemDue(md, 3, '2026-11-25'), 3)).toBe(
      '- question: Which vendor? due:2026-11-25',
    );
  });

  it('refuses a reminder without a date, bad dates and times', () => {
    expect(setItemDue(md, 2, null)).toBeNull();
    expect(setItemDue(md, 1, '25/11/2026')).toBeNull();
    expect(setItemDue(md, 1, '2026-11-25', '25:00')).toBeNull();
    expect(setItemDue(md, 9, '2026-11-25')).toBeNull();
  });
});

describe('removeItem', () => {
  it('removes only item lines', async () => {
    const { removeItem } = await import('@shared/items');
    expect(removeItem('a\n- [ ] todo: x\nb', 2)).toBe('a\nb');
    expect(removeItem('a\n- [ ] todo: x\nb', 1)).toBeNull();
    expect(removeItem('```\n- [ ] todo: x\n```', 2)).toBeNull();
  });
});

describe('multi-line answers', () => {
  it('reads an answer that goes on over indented lines, and skips them as items', async () => {
    const { extractItems } = await import('@shared/items');
    const md = [
      '- [x] question: Which? answer: Two:',
      '  - first',
      '  - todo: not an item here',
      '',
      '  > a quote',
      'After',
    ].join('\n');
    const items = extractItems(md);
    expect(items).toHaveLength(1);
    expect(items[0]!.answer).toBe('Two:\n- first\n- todo: not an item here\n\n> a quote');
    expect(items[0]!.answer_lines).toBe(4);
    expect(items[0]!.done).toBe(true);
  });

  it('writes a multi-line answer, replaces it, and clears it', async () => {
    const { setItemAnswer, extractItems } = await import('@shared/items');
    let md = '- question: Why?\nNext';
    md = setItemAnswer(md, 1, 'Because:\n- one\n- two')!;
    expect(md).toBe('- [x] question: Why? answer: Because:\n  - one\n  - two\nNext');
    md = setItemAnswer(md, 1, '- only a list')!;
    expect(md).toBe('- [x] question: Why? answer:\n  - only a list\nNext');
    expect(extractItems(md)[0]!.answer).toBe('- only a list');
    md = setItemAnswer(md, 1, '')!;
    expect(md).toBe('- [ ] question: Why?\nNext');
  });

  it('deletes an item with its answer lines', async () => {
    const { removeItem, itemLines } = await import('@shared/items');
    const md = '- [x] question: Q? answer: A\n  - more\nNext';
    expect(itemLines(md, 1)).toEqual(['- [x] question: Q? answer: A', '  - more']);
    expect(removeItem(md, 1)).toBe('Next');
  });
});

describe('editItem', () => {
  it('changes type, text, date and time, keeping the owner', async () => {
    const { editItem } = await import('@shared/items');
    const md = '- [ ] todo: Call Sam @tyler due:2026-11-20';
    expect(
      editItem(md, 1, { type: 'reminder', text: 'Call Sam back', due: '2026-11-21', time: '9:30' }),
    ).toBe('- reminder: Call Sam back @tyler due:2026-11-21 09:30');
    expect(
      editItem(md, 1, { type: 'question', text: 'Call Sam?', due: '2026-11-21', time: null }),
    ).toBe('- question: Call Sam? @tyler due:2026-11-21');
    expect(editItem(md, 1, { type: 'todo', text: 'Call Sam', due: null, time: null })).toBe(
      '- [ ] todo: Call Sam @tyler',
    );
    // Reminders need a date; empty text isn't an item.
    expect(editItem(md, 1, { type: 'reminder', text: 'x', due: null, time: null })).toBeNull();
    expect(editItem(md, 1, { type: 'todo', text: '  ', due: null, time: null })).toBeNull();
  });

  it('keeps a question’s answer, and drops it when it becomes a to-do', async () => {
    const { editItem } = await import('@shared/items');
    const md = '- [x] question: Q? answer: A\n  - more';
    expect(editItem(md, 1, { type: 'question', text: 'Q2?', due: null, time: null })).toBe(
      '- [x] question: Q2? answer: A\n  - more',
    );
    expect(editItem(md, 1, { type: 'todo', text: 'Do Q', due: null, time: null })).toBe(
      '- [x] todo: Do Q',
    );
  });
});

describe('answers with a lone dash', () => {
  it('never turn the question into a heading', async () => {
    const { setItemAnswer, extractItems } = await import('@shared/items');
    const md = setItemAnswer('- question: Q?', 1, 'one\n-\n- two')!;
    expect(md).toBe('- [x] question: Q? answer: one\n\n  -\n  - two');
    expect(extractItems(md)[0]!.answer).toBe('one\n\n-\n- two');
  });
});
