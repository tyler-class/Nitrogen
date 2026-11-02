import { describe, expect, it } from 'vitest';
import { writeFileSync } from 'node:fs';
import { loadFixtures } from '@nitrogen/spec';
import { autofix, lintPage, normalize, parsePage, semanticFingerprint, extractIndexRows, indexRowsFromScan, lintScan, scanPage } from '../src/index.ts';
import { ctx, FIXTURE_PATH } from './helpers.ts';

const UPDATE = process.env.UPDATE_FIXTURES === '1';
const fixtures = loadFixtures();

function golden(f: ReturnType<typeof loadFixtures>[number], ext: string, actual: string) {
  if (UPDATE) {
    writeFileSync(f.filePath(ext), actual);
    return;
  }
  const expected = f.file(ext);
  expect(expected, `missing golden ${f.name}.${ext}; run UPDATE_FIXTURES=1`).not.toBeNull();
  expect(actual).toBe(expected);
}

/** Fixtures whose layout is intentionally invalid are excluded from loss tests. */
const LOSSY_INPUT = new Set(['toggles-no-blank', 'drawers-nested', 'drawers-in-list', 'frontmatter-nested', 'frontmatter-block-scalar', 'frontmatter-types', 'html-disallowed']);

describe.each(fixtures)('fixture $name', (f) => {
  const opts = { path: FIXTURE_PATH };

  it('lints to the expected diagnostics (full parser)', () => {
    const got = lintPage(f.input, ctx, opts).map((d) => ({ code: d.code, line: d.line }));
    expect(got).toEqual(f.diagnostics);
  });

  it('light scanner matches the full parser (parity)', () => {
    const full = parsePage(f.input).scan;
    const light = scanPage(f.input);
    expect(light).toEqual(full);
    expect(lintScan(light, f.input, ctx, opts)).toEqual(lintScan(full, f.input, ctx, opts));
    expect(indexRowsFromScan(FIXTURE_PATH, f.input, 'sha', light, ctx)).toEqual(extractIndexRows(FIXTURE_PATH, f.input, 'sha', ctx));
  });

  it('index rows match golden', () => {
    const rows = extractIndexRows(FIXTURE_PATH, f.input, 'sha', ctx);
    golden(f, 'index.json', `${JSON.stringify({ page: { ...rows.page, body: undefined }, links: rows.links, images: rows.images, headings: rows.headings }, null, 2)}\n`);
  });

  for (const [profile, ext] of [['gfm', 'gfm.md'], ['commonmark', 'cm.md']] as const) {
    it(`normalizes to golden (${profile})`, () => {
      golden(f, ext, normalize(f.input, profile, ctx, opts).src);
    });

    it(`normalize is idempotent (${profile})`, () => {
      const once = normalize(f.input, profile, ctx, opts).src;
      expect(normalize(once, profile, ctx, opts).src).toBe(once);
    });

    it.skipIf(LOSSY_INPUT.has(f.name))(`preserves semantics (${profile})`, () => {
      const out = normalize(f.input, profile, ctx, opts).src;
      // Wikilinks are resolved by autofix first; that is part of the documented mapping.
      const before = semanticFingerprint(autofix(f.input, ctx, opts).src, { path: FIXTURE_PATH, inlineFrontmatter: profile === 'commonmark' });
      expect(semanticFingerprint(out, { path: FIXTURE_PATH })).toEqual(before);
    });

    it(`leaves no CFM-only syntax (${profile})`, () => {
      const out = normalize(f.input, profile, ctx, opts).src;
      const tree = parsePage(out).scan;
      expect(tree.drawers).toEqual([]);
      expect(tree.tableDirectives).toEqual([]);
      expect(tree.images.filter((i) => i.src.includes('#'))).toEqual([]);
      expect(out).not.toMatch(/<!--\s*nitrogen:/);
      if (profile === 'commonmark') {
        if (!LOSSY_INPUT.has(f.name)) expect(tree.html.filter((h) => h.tag !== '!--')).toEqual([]);
        expect(tree.callouts).toEqual([]);
      } else {
        expect(tree.callouts.every((c) => ['note', 'tip', 'important', 'warning', 'caution'].includes(c.type) && c.fold === '' && c.title === '')).toBe(true);
      }
    });
  }
});
