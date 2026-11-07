import { describe, expect, it } from 'vitest';
import { extractItems, parseItemLine, setItemDone } from '@shared/items';

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
