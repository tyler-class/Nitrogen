import { describe, expect, it } from 'vitest';
import { dueTime, extractItems, parseItemLine, setItemDone } from '@shared/items';

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
