import { describe, expect, it } from 'vitest';
import { headingsOf } from '../../src/client/lib/outline';

describe('page outline', () => {
  it('lists three levels of headings with the renderer’s anchors, skipping code blocks', () => {
    const body = [
      '# Plan',
      'text',
      '## Next **steps**',
      '```',
      '# not a heading',
      '```',
      '### [[Roadmap|The roadmap]]',
      '#### Too deep',
      '## Next steps',
      '#nottag heading',
    ].join('\n');
    expect(headingsOf(body, 3)).toEqual([
      { level: 1, text: 'Plan', id: 'plan', line: 1 },
      { level: 2, text: 'Next steps', id: 'next-steps', line: 3 },
      { level: 3, text: 'The roadmap', id: 'the-roadmap', line: 7 },
      { level: 2, text: 'Next steps', id: 'next-steps-1', line: 9 },
    ]);
  });

  it('is empty for a page without headings', () => {
    expect(headingsOf('just text\n- a list', 3)).toEqual([]);
  });
});
