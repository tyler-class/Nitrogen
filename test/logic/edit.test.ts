import { describe, expect, it } from 'vitest';
import { applyEdits, EditError, headings } from '../../src/shared/edit';
import {
  extractFileKeys,
  extractLinks,
  ftsQuery,
  plainText,
  slugify,
} from '../../src/shared/markdown';
import { buildTree, ancestorsOf, outline } from '../../src/shared/tree';

const doc = `Intro line.

## Goals

- Ship it

## Notes

Some notes.

### Detail

Deep.

## Done
`;

describe('applyEdits', () => {
  it('replaces unique text and refuses ambiguous or missing text', () => {
    expect(applyEdits('a b c', [{ type: 'replace', find: 'b', replace: 'B' }])).toBe('a B c');
    expect(() => applyEdits('a a', [{ type: 'replace', find: 'a', replace: 'x' }])).toThrow(
      EditError,
    );
    expect(applyEdits('a a', [{ type: 'replace', find: 'a', replace: 'x', all: true }])).toBe(
      'x x',
    );
    expect(() => applyEdits('abc', [{ type: 'delete', find: 'zzz' }])).toThrow(/Could not find/);
  });

  it('treats $ in replacements literally', () => {
    expect(applyEdits('price', [{ type: 'replace', find: 'price', replace: '$& $1' }])).toBe(
      '$& $1',
    );
  });

  it('appends to and replaces sections by heading, including nested ones', () => {
    const appended = applyEdits(doc, [
      { type: 'append_to_section', heading: 'goals', text: '- Test it' },
    ]);
    expect(appended).toContain('- Ship it\n\n- Test it\n\n## Notes');
    // A section includes its subsections.
    const notes = applyEdits(doc, [
      { type: 'replace_section', heading: 'Notes', text: 'Replaced.' },
    ]);
    expect(notes).toContain('## Notes\n\nReplaced.\n\n## Done');
    expect(notes).not.toContain('### Detail');
  });

  it('adds sections at the end or under a heading', () => {
    const top = applyEdits(doc, [{ type: 'add_section', heading: 'Risks', text: 'None.' }]);
    expect(top.trimEnd().endsWith('## Risks\n\nNone.')).toBe(true);
    const sub = applyEdits(doc, [
      { type: 'add_section', heading: 'More', text: 'x', under: 'Notes' },
    ]);
    expect(sub).toContain('Deep.\n\n### More\n\nx\n\n## Done');
  });

  it('is all-or-nothing and says which edit failed', () => {
    expect(() =>
      applyEdits(doc, [
        { type: 'append', text: 'ok' },
        { type: 'append_to_section', heading: 'Nope', text: 'x' },
      ]),
    ).toThrow(
      /Edit 2 \(append_to_section\): No heading named “Nope”. Headings on this page: ## Goals/,
    );
  });

  it('ignores headings inside code fences', () => {
    expect(headings('```\n# not a heading\n```\n# Real').map((h) => h.text)).toEqual(['Real']);
  });
});

describe('markdown helpers', () => {
  it('extracts wikilinks and page links outside code', () => {
    const md =
      'See [[Roadmap]], [[Plans|the plan]] and [x](/p/abc123/slug#h).\n\n`[[Not]]`\n```\n[[Nope]]\n```';
    expect(extractLinks(md)).toEqual({ titles: ['roadmap', 'plans'], ids: ['abc123'] });
  });

  it('finds image keys', () => {
    expect(extractFileKeys('![a](/files/img/abc.png) ![b](/files/img/def.webp)')).toEqual([
      'img/abc.png',
      'img/def.webp',
    ]);
  });

  it('makes plain text and slugs', () => {
    expect(plainText('## Hi **there** [[Page|label]] ![x](/files/a.png)')).toBe('Hi there label');
    expect(slugify('Café Plans: 2026!')).toBe('cafe-plans-2026');
  });

  it('builds safe FTS queries', () => {
    expect(ftsQuery('hello "world" OR x*')).toBe('"hello" "world" "OR" "x"*');
    expect(ftsQuery('  ')).toBeNull();
  });
});

describe('tree', () => {
  const pages = [
    { id: 'b', parent_id: 'a', position: 1, title: 'B', icon: null, updated_at: '' },
    { id: 'a', parent_id: null, position: 0, title: 'A', icon: '📘', updated_at: '' },
    { id: 'c', parent_id: 'a', position: 0, title: 'C', icon: null, updated_at: '' },
  ];
  it('nests and orders siblings by position', () => {
    const roots = buildTree(pages);
    expect(roots.map((r) => r.page.id)).toEqual(['a']);
    expect(roots[0]!.children.map((c) => c.page.id)).toEqual(['c', 'b']);
    expect(outline(roots)).toEqual(['- 📘 A (a)', '  - C (c)', '  - B (b)']);
  });
  it('lists ancestors root first', () => {
    expect(ancestorsOf('b', new Map(pages.map((p) => [p.id, p]))).map((p) => p.id)).toEqual(['a']);
  });
});
