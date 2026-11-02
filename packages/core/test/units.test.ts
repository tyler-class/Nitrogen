import { describe, expect, it } from 'vitest';
import GithubSlugger from 'github-slugger';
import {
  autofix,
  canonicalImageFragment,
  checkPagePath,
  checkWrite,
  findInbound,
  formatConfig,
  kebabSuggestion,
  linkMention,
  parseConfig,
  parseFrontmatter,
  relativePath,
  resolveLink,
  resolveWikilink,
  rewriteLinks,
  scanPage,
  setFrontmatterKey,
  createSlugger,
  buildVaultContext,
  exportPages,
  contextAt,
  deriveMeta,
} from '../src/index.ts';
import { ctx } from './helpers.ts';

describe('frontmatter', () => {
  it('parses the strict subset', () => {
    const fm = parseFrontmatter('---\ntitle: "A: b"\ntags: [x, \'y z\']\norder: -3\npinned: true\nempty:\n---\nbody');
    expect(fm.errors).toEqual([]);
    expect(fm.data).toEqual({ title: 'A: b', tags: ['x', 'y z'], order: -3, pinned: true, empty: null });
    expect(fm.lineCount).toBe(7);
  });
  it('accepts a single string for tags', () => {
    expect(parseFrontmatter('---\ntags: solo\n---\n').data.tags).toEqual(['solo']);
  });
  it('rejects anchors, maps and unquoted colons', () => {
    const fm = parseFrontmatter('---\na: &x 1\nb: {c: 1}\nc: has: colon\n---\n');
    expect(fm.errors.map((e) => e.line)).toEqual([2, 3, 4]);
  });
  it('sets and removes keys preserving others', () => {
    const src = '---\ntitle: X\norder: 2\n---\n# X\n';
    expect(setFrontmatterKey(src, 'order', 5)).toBe('---\ntitle: X\norder: 5\n---\n# X\n');
    expect(setFrontmatterKey(src, 'pinned', true)).toBe('---\ntitle: X\norder: 2\npinned: true\n---\n# X\n');
    expect(setFrontmatterKey(src, 'order', null)).toBe('---\ntitle: X\n---\n# X\n');
    expect(setFrontmatterKey('# Y\n', 'order', 1)).toBe('---\norder: 1\n---\n# Y\n');
    expect(setFrontmatterKey(src, 'title', 'Needs: quotes')).toContain('title: "Needs: quotes"');
  });
  it('derives titles: frontmatter, H1, file name', () => {
    expect(deriveMeta(parseFrontmatter(''), 'From H1', 'a/b.md').title).toBe('From H1');
    expect(deriveMeta(parseFrontmatter(''), undefined, 'a/sync-design.md').title).toBe('Sync design');
    expect(deriveMeta(parseFrontmatter(''), undefined, 'arch/index.md').title).toBe('Arch');
  });
});

describe('config', () => {
  it('parses, defaults and warns on unknown keys', () => {
    const r = parseConfig('version: 1\nassets_dir: /media/\nfoo: 1\nlink_relations: [cites]\n');
    expect(r.config.assets_dir).toBe('media');
    expect(r.config.link_relations).toEqual(['related', 'cites']);
    expect(r.warnings).toHaveLength(1);
    expect(parseConfig(formatConfig(r.config)).config).toEqual(r.config);
  });
  it('reports invalid values', () => {
    expect(parseConfig('version: 2\npage_size_warn_kb: -1\n').errors).toHaveLength(2);
  });
});

describe('paths', () => {
  it('computes relative paths', () => {
    expect(relativePath('a/b/c.md', 'a/d.md')).toBe('../d.md');
    expect(relativePath('a/c.md', 'a/d.md')).toBe('d.md');
    expect(relativePath('index.md', 'a/d.md')).toBe('a/d.md');
    expect(relativePath('a/b/c.md', 'x/y.md')).toBe('../../x/y.md');
  });
  it('validates write paths (E009)', () => {
    const ig = ctx.config.ignore;
    expect(checkPagePath('notes/a.md', ig).ok).toBe(true);
    for (const bad of ['/a.md', '../a.md', 'a/../b.md', '.nitrogen/config.md', 'images/x.md', '_exports/x.md', 'a.txt', 'FORMAT.md', ''])
      expect(checkPagePath(bad, ig).ok, bad).toBe(false);
  });
  it('suggests kebab names', () => {
    expect(kebabSuggestion('Notes/My Page_Two.md')).toBe('Notes/my-page-two.md');
    expect(kebabSuggestion('camelCase.md')).toBe('camel-case.md');
  });
});

describe('slugs', () => {
  it('match github-slugger', () => {
    const ours = createSlugger();
    const theirs = new GithubSlugger();
    for (const t of ['Hello World', 'ADR-004: Direct commits', 'Ünïcödé & ümlauts', '`code` and link', 'Repeat', 'Repeat', '日本語', 'emoji 🚀 here'])
      expect(ours.slug(t)).toBe(theirs.slug(t));
  });
});

describe('resolve', () => {
  it('resolves links', () => {
    expect(resolveLink('/architecture/sync-design.md#commit-flow', 'x.md', ctx)).toEqual({ kind: 'page', path: 'architecture/sync-design.md', anchor: 'commit-flow', exists: true });
    expect(resolveLink('../index.md', 'notes/x.md', ctx)).toMatchObject({ kind: 'page', path: 'index.md', exists: true });
    expect(resolveLink('/architecture/', 'x.md', ctx)).toMatchObject({ path: 'architecture/index.md', exists: true });
    expect(resolveLink('/architecture', 'x.md', ctx)).toMatchObject({ path: 'architecture/index.md', exists: true });
    expect(resolveLink('#top', 'x.md', ctx)).toEqual({ kind: 'self', anchor: 'top' });
    expect(resolveLink('https://x.y', 'x.md', ctx).kind).toBe('external');
    expect(resolveLink('/../x.md', 'x.md', ctx).kind).toBe('invalid');
  });
  it('resolves wikilinks in spec order', () => {
    expect(resolveWikilink('architecture/sync-design', ctx)).toMatchObject({ status: 'ok', via: 'path' });
    expect(resolveWikilink('sync DESIGN', ctx)).toMatchObject({ status: 'ok', via: 'title' });
    expect(resolveWikilink('Commit pipeline', ctx)).toMatchObject({ status: 'ok', via: 'alias' });
    expect(resolveWikilink('sync-design', ctx)).toMatchObject({ status: 'ok', via: 'basename' });
    expect(resolveWikilink('Dup', ctx).status).toBe('ambiguous');
    expect(resolveWikilink('nope', ctx).status).toBe('missing');
  });
});

describe('autofix', () => {
  it('canonicalizes wikilinks, fragments, newlines', () => {
    const { src, fixes } = autofix('# X\r\n\r\nSee [[Sync design#Commit flow]] and ![a](/images/2026/11/atom.svg#w=1&align=left)', ctx, { path: 'notes/My Page.md' });
    expect(src).toBe('# X\n\nSee [Sync design > Commit flow](/architecture/sync-design.md#commit-flow) and ![a](/images/2026/11/atom.svg#align=left&w=1)\n');
    expect(fixes.map((f) => f.kind)).toEqual(['line-endings', 'wikilink', 'image-fragment', 'trailing-newline', 'rename-suggestion']);
  });
  it('leaves unresolved wikilinks and is idempotent', () => {
    const once = autofix('[[nope]] [[Dup]]\n', ctx).src;
    expect(once).toBe('[[nope]] [[Dup]]\n');
    expect(autofix(once, ctx).src).toBe(once);
  });
  it('does not touch code', () => {
    const s = '`[[Sync design]]`\n\n```\n[[Sync design]]\n```\n';
    expect(autofix(s, ctx).src).toBe(s);
  });
  it('canonical image fragment order', () => {
    expect(canonicalImageFragment('border=true&w=3&align=left&x=1')).toBe('align=left&w=3&border=true&x=1');
  });
});

describe('rewriteLinks / move', () => {
  it('rewrites inbound links, keeping anchors, titles and style', () => {
    const src = 'A [x](/old/page.md#h "rel:cites") [y](page.md) [z](<../old/page.md>) ![i](/images/a.png)\n\n[ref]: /old/page.md\n';
    const m = new Map([['old/page.md', 'new/place.md']]);
    expect(rewriteLinks(src, m, 'old/other.md')).toBe('A [x](/new/place.md#h "rel:cites") [y](../new/place.md) [z](<../new/place.md>) ![i](/images/a.png)\n\n[ref]: /new/place.md\n');
  });
  it('rewrites relative links of the moved page itself', () => {
    const src = '[up](../index.md) [root](/index.md)';
    expect(rewriteLinks(src, new Map([['a/b.md', 'c/d/b.md']]), 'a/b.md')).toBe('[up](../../index.md) [root](/index.md)');
  });
  it('finds inbound pages', () => {
    expect(findInbound('t.md', [{ path: 'a.md', content: '[t](/t.md)' }, { path: 'b.md', content: '`[t](/t.md)`' }, { path: 'c/d.md', content: '[t](../t.md#x)' }])).toEqual(['a.md', 'c/d.md']);
  });
});

describe('linkMention', () => {
  const src = '---\ntitle: Sync design notes\n---\n# Sync design\n\nThe `sync design` code. We use [sync design](/x.md) already.\n\nOur sync Design is good. Sync design again.\n';
  it('links the first eligible mention, preserving case', () => {
    const r = linkMention(src, 'Sync design', 'architecture/sync-design.md');
    expect(r?.line).toBe(8);
    expect(r?.src).toContain('Our [sync Design](/architecture/sync-design.md) is good. Sync design again.');
  });
  it('respects a paragraph restriction and word boundaries', () => {
    expect(linkMention(src, 'Sync design', 'x.md', { line: 6 })).toBeNull();
    expect(linkMention('Syncing designs', 'Sync design', 'x.md')).toBeNull();
  });
});

describe('write checks', () => {
  it('E009 and E010', () => {
    expect(checkWrite('.github/x.md', null, ctx).map((d) => d.code)).toEqual(['E009']);
    expect(checkWrite('a.md', scanPage('---\nlocked: true\n---\n'), ctx).map((d) => d.code)).toEqual(['E010']);
  });
});

describe('context and export', () => {
  const files = [
    { path: '.nitrogen/config.yml', content: 'version: 1\n' },
    { path: 'index.md', content: '# Home\n\n[A](/a/b.md) ![p](/images/x.png#w=10)\n' },
    { path: 'a/b.md', content: '---\ntitle: B page\naliases: [Bee]\n---\n\n## Part\n\n[home](/index.md)\n' },
    { path: 'images/x.png' },
    { path: '.github/workflows/x.md', content: '# no' },
  ];
  it('builds a vault context', () => {
    const c = buildVaultContext(files);
    expect(c.pages.map((p) => p.path)).toEqual(['a/b.md', 'index.md']);
    expect(c.pages[0]).toEqual({ path: 'a/b.md', title: 'B page', aliases: ['Bee'], slugs: ['part'] });
    expect(c.images).toEqual(['images/x.png']);
  });
  it('exports with page-relative links and copied assets', () => {
    const c = buildVaultContext(files);
    const pages = files.filter((f) => c.pages.some((p) => p.path === f.path)) as { path: string; content: string }[];
    const r = exportPages(pages, c, { profile: 'gfm' });
    expect(r.assets).toEqual([{ from: 'images/x.png', to: 'assets/x.png' }]);
    expect(r.files.find((f) => f.path === 'index.md')!.content).toBe('# Home\n\n[A](a/b.md) ![p](assets/x.png)\n');
    expect(r.files.find((f) => f.path === 'a/b.md')!.content).toContain('[home](../index.md)');
  });
});

describe('contextAt', () => {
  it('returns the containing paragraph, truncated around the link', () => {
    const lines = ['# T', '', 'Line one with', 'a [link](/x.md) here.', '', 'Other.'];
    expect(contextAt(lines, 4, 'link')).toBe('Line one with a link here.');
    const long = ['x '.repeat(200) + '[needle](/n.md) ' + 'y '.repeat(200)];
    const c = contextAt(long, 1, 'needle');
    expect(c.length).toBeLessThanOrEqual(240);
    expect(c).toContain('needle');
  });
});
