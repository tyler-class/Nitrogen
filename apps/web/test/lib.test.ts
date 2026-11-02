import { describe, expect, it } from 'vitest';
import { buildTree, siblingsOf, visibleRows, crumbs, compareNodes } from '../src/lib/tree.ts';
import { threeWay, resolve } from '../src/lib/merge.ts';
import { buildTable } from '../src/editor/TableBuilder.tsx';
import { buildImageMarkdown } from '../src/editor/ImageDialog.tsx';
import { layout } from '../src/routes/LinkExplorer.tsx';
import { escapeExceptMark } from '../src/routes/misc.tsx';
import { lintPage, buildVaultContext } from '@nitrogen/core';
import type { TreePage } from '../src/api/types.ts';

const P = (path: string, title: string, ord: number | null = null): TreePage => ({ path, title, ord, icon: null, status: null, pinned: false, locked: false, tags: [], aliases: [] });

describe('tree', () => {
  const pages = [P('index.md', 'Home'), P('b/index.md', 'Bee', 2), P('b/z.md', 'Zed'), P('b/a10.md', 'Item 10'), P('b/a2.md', 'Item 2'), P('a/x.md', 'Ex'), P('first.md', 'First', 1)];
  const root = buildTree(pages);
  it('sorts by order then natural title, synthesizes folders', () => {
    expect(root.children.map((c) => c.title)).toEqual(['First', 'Bee', 'A']);
    const b = root.children[1]!;
    expect(b.page).toBe('b/index.md');
    expect(b.children.map((c) => c.title)).toEqual(['Item 2', 'Item 10', 'Zed']);
    expect(root.children[2]!.page).toBeNull();
    expect(compareNodes({ ord: null, title: 'a' }, { ord: 5, title: 'b' })).toBeGreaterThan(0);
  });
  it('flattens visible rows and finds siblings and crumbs', () => {
    expect(visibleRows(root, new Set(['b'])).map((r) => r.node.title)).toEqual(['First', 'Bee', 'Item 2', 'Item 10', 'Zed', 'A']);
    expect(siblingsOf(root, 'b/a10.md')).toMatchObject({ prev: { title: 'Item 2' }, next: { title: 'Zed' } });
    expect(siblingsOf(root, 'b/index.md')).toMatchObject({ prev: { title: 'First' }, next: null });
    const t = (p: string) => pages.find((x) => x.path === p)?.title;
    expect(crumbs('b/z.md', t).map((c) => c.label)).toEqual(['Home', 'Bee']);
    expect(crumbs('a/x.md', t)).toEqual([{ label: 'Home', href: '/' }, { label: 'A', href: null }]);
  });
});

describe('merge', () => {
  it('merges non-overlapping edits and exposes conflicts', () => {
    const base = 'a\nb\nc\nd\n';
    expect(threeWay(base, 'A\nb\nc\nd\n', 'a\nb\nc\nD\n')).toMatchObject({ clean: true, merged: 'A\nb\nc\nD\n' });
    const c = threeWay(base, 'a\nMINE\nc\nd\n', 'a\nTHEIRS\nc\nd\n');
    expect(c.clean).toBe(false);
    expect(resolve(c.hunks, ['theirs'])).toBe('a\nTHEIRS\nc\nd\n');
    expect(resolve(c.hunks, ['both'])).toBe('a\nMINE\nTHEIRS\nc\nd\n');
  });
});

describe('builders emit valid CFM', () => {
  const ctx = buildVaultContext([{ path: 'images/2026/11/x-abc123.webp' }]);
  it('table builder', () => {
    const md = buildTable([['A', 'B|C'], ['1', '2']], ['left', 'right'], { style: 'zebra', header: 'sticky', caption: 'Cap', dense: false, widths: '40,60' });
    expect(md).toContain('<!--nitrogen:table style=zebra header=sticky widths=40,60 caption="Cap"-->');
    expect(md).toContain('B\\|C');
    expect(lintPage(`# T\n\n${md}\n`, ctx, { path: 't.md' })).toEqual([]);
  });
  it('image markdown', () => {
    const md = buildImageMarkdown('Alt', 'images/2026/11/x-abc123.webp', { align: 'right', w: '40%', wrap: true, zoom: false, border: true }, 'Cap "q"');
    expect(md).toBe(`![Alt](/images/2026/11/x-abc123.webp#align=right&w=40%&zoom=false&border=true "Cap 'q'")`);
    expect(lintPage(`# T\n\n${md}\n`, ctx, { path: 't.md' })).toEqual([]);
  });
});

describe('explorer layout', () => {
  it('is deterministic', () => {
    const h = { center: 'a', nodes: ['a', 'b', 'c', 'd'].map((p) => ({ path: p, title: p, excerpt: '', missing: false })), edges: [{ src: 'a', dst: 'b', rel: 'related', n: 1 }, { src: 'c', dst: 'a', rel: 'cites', n: 1 }, { src: 'b', dst: 'd', rel: 'related', n: 1 }], truncated: false };
    expect([...layout(h, 2)]).toEqual([...layout(h, 2)]);
    expect(layout(h, 1).get('a')).toEqual({ x: 280, y: 280 });
  });
});

describe('search snippets', () => {
  it('escape everything except mark', () => {
    expect(escapeExceptMark('<img onerror=x> <mark>hit</mark> &')).toBe('&lt;img onerror=x&gt; <mark>hit</mark> &amp;');
  });
});
