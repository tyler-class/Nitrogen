import { describe, expect, it } from 'vitest';
import { fileName, toPlainMarkdown } from '@shared/export';

describe('plain markdown export', () => {
  it('downgrades callouts, items and wikilinks', () => {
    const md = [
      '> [!TIP] Remember',
      '> Text',
      '',
      '- [ ] todo: Ship [[Roadmap]] @sam due:2026-11-20',
      '- [x] question: Which? answer: This one.',
      '',
      'See [[Roadmap|the plan]] and ![x](/files/img/a.png).',
      '```',
      '- todo: code stays',
      '```',
    ].join('\n');
    const out = toPlainMarkdown(md, {
      origin: 'https://n2.example',
      link: (t) => (t === 'Roadmap' ? '../Roadmap.md' : null),
    });
    expect(out).toBe(
      [
        '> **Tip: Remember**',
        '> Text',
        '',
        '> **To do:** Ship [Roadmap](../Roadmap.md) (@sam, due 2026-11-20)',
        '>',
        '> **Question (done):** Which? **Answer:** This one.',
        '',
        'See [the plan](../Roadmap.md) and ![x](https://n2.example/files/img/a.png).',
        '```',
        '- todo: code stays',
        '```',
      ].join('\n'),
    );
  });
  it('makes safe file names', () => {
    expect(fileName('A/B: C?')).toBe('A-B- C-');
  });
});
