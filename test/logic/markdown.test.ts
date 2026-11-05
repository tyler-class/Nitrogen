import { describe, expect, it } from 'vitest';
import { extractTags, linkFirstMention, normalizeTag, splitTags } from '@shared/markdown';

describe('tags', () => {
  it('finds #tags in prose only', () => {
    expect(
      extractTags(
        '#Ideas start\n## Heading\nSee [a](#anchor), [[Page#Part]], `#code`, https://x.y/#frag, #two-words, issue #12.',
      ),
    ).toEqual(['ideas', 'two-words']);
  });
  it('normalizes', () => {
    expect(normalizeTag('#Home Ideas!')).toBe('home-ideas');
    expect(normalizeTag('###')).toBe('');
  });
  it('splits text for rendering', () => {
    expect(splitTags('a #b c')).toEqual([{ text: 'a ' }, { tag: 'b', raw: '#b' }, { text: ' c' }]);
  });
});

describe('linkFirstMention', () => {
  it('links the first plain mention, keeping its wording', () => {
    expect(linkFirstMention('About the roadmap and Roadmap.', 'Roadmap')).toBe(
      'About the [[Roadmap|roadmap]] and Roadmap.',
    );
  });
  it('skips code, links and partial words', () => {
    expect(linkFirstMention('`Roadmap` [[Roadmap]] Roadmaps', 'Roadmap')).toBeNull();
  });
});
