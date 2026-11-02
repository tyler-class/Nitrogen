import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { loadFixtures } from '@nitrogen/spec';
import { buildVaultContext } from '@nitrogen/core';
import { renderToHtml, renderToHast } from '../src/index.ts';

const demo = join(import.meta.dirname, '../../../examples/notes-repo');
const tour = readFileSync(join(demo, 'welcome/format-tour.md'), 'utf8');
const ctx = buildVaultContext([
  { path: 'index.md', content: '# Home' },
  { path: 'architecture/sync-design.md', content: '---\ntitle: Sync design\n---\n# Sync design\n## Commit flow' },
  { path: 'decisions/adr-004-direct-commits.md', content: '# ADR-004' },
  { path: 'images/2026/11/n2.svg' },
]);

describe('render', () => {
  const html = renderToHtml(tour, { path: 'welcome/format-tour.md', ctx });
  it('renders every construct', () => {
    expect(html).toContain('<aside class="callout callout-note">');
    expect(html).toContain('<p class="callout-title">Foldable warning</p>');
    expect(html).toContain('<details class="drawer"><summary>Field reference</summary>');
    expect(html).toMatch(/<details>\s*<summary>Why source editing\?<\/summary>/);
    expect(html).toContain('<figure class="n2-figure" data-align="right" data-w="200"');
    expect(html).toContain('<figcaption>Figure 1: dinitrogen</figcaption>');
    expect(html).toContain('src="/api/blob?path=images%2F2026%2F11%2Fn2.svg"');
    expect(html).toContain('data-style="zebra"');
    expect(html).toContain('<pre class="mermaid">flowchart LR');
    expect(html).toContain('href="/p/architecture/sync-design.md#commit-flow" data-page="architecture/sync-design.md" data-rel="cites"');
    expect(html).toContain('target="_blank" rel="noopener noreferrer" data-external="true"');
    expect(html).toContain('<kbd>Cmd</kbd>');
    expect(html).toContain('<h2 id="links">Links</h2>');
    expect(html).not.toContain('title: Format tour');
    expect(html).not.toContain('rel:cites');
  });

  it('sanitizes dangerous HTML', () => {
    const out = renderToHtml('# X\n\n<script>alert(1)</script>\n\n<img src=x onerror=alert(1)>\n\n<a href="javascript:alert(1)">x</a>\n\n<details open onclick="x()"><summary>s</summary>\n\nok\n\n</details>\n', { path: 'x.md', ctx: null });
    expect(out).not.toMatch(/<script|onerror|javascript:|onclick/);
    expect(out).toContain('<details open>');
  });

  it('marks broken links and unresolved wikilinks', () => {
    const out = renderToHtml('[x](/nope.md) [[Missing page]] [[Sync design]]', { path: 'x.md', ctx });
    expect(out).toContain('data-broken="true"');
    expect(out).toContain('<span class="wikilink-missing">Missing page</span>');
    expect(out).toContain('href="/p/architecture/sync-design.md"');
  });

  it('reads the normalized GFM lead-title convention', () => {
    const out = renderToHtml('> [!NOTE]\n> **Decision: Ship it**\n>\n> Body.\n', { path: 'x.md', ctx: null });
    expect(out).toContain('callout-decision');
    expect(out).toContain('>Ship it</p>');
  });

  it('renders every fixture without throwing', () => {
    for (const f of loadFixtures()) expect(() => renderToHast(f.input, { path: 'notes/fixture.md', ctx })).not.toThrow();
  });
});
