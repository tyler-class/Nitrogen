import { describe, expect, it } from 'vitest';
import fc from 'fast-check';
import { autofix, normalize, parsePage, scanPage, semanticFingerprint } from '../src/index.ts';
import { ctx, FIXTURE_PATH } from './helpers.ts';

const word = fc.constantFrom('alpha', 'beta', 'gamma', 'delta', 'river', 'stone', 'cloud', 'Sync', 'design', 'plan', 'graph', 'node');
const words = fc.array(word, { minLength: 1, maxLength: 6 }).map((w) => w.join(' '));
const target = fc.constantFrom('/architecture/sync-design.md', '/index.md', '/decisions/adr-002.md', '../index.md', 'other.md', '/missing.md');
const rel = fc.constantFrom('', ' "rel:supersedes"', ' "rel:cites"', ' "plain title"');
const link = fc.tuple(words, target, rel).map(([t, h, r]) => `[${t}](${h}${r})`);
const image = fc
  .tuple(words, fc.constantFrom('', '#align=right&w=120', '#w=50%', '#zoom=false&border=true'), fc.constantFrom('', ' "A caption"'))
  .map(([a, f, c]) => `![${a}](/images/2026/11/atom.svg${f}${c})`);
const inline = fc.oneof({ weight: 4, arbitrary: words }, link, image, words.map((w) => `**${w}**`), words.map((w) => `\`${w}\``), fc.constant('[[Sync design]]'));
const para = fc.array(inline, { minLength: 1, maxLength: 5 }).map((xs) => xs.join(' '));
const calloutType = fc.constantFrom('note', 'tip', 'important', 'warning', 'caution', 'info', 'question', 'success', 'danger', 'example', 'quote', 'decision', 'assumption');

const leafBlock = fc.oneof(
  { weight: 4, arbitrary: para },
  fc.tuple(fc.integer({ min: 2, max: 4 }), words).map(([n, w]) => `${'#'.repeat(n)} ${w}`),
  fc.array(para, { minLength: 1, maxLength: 3 }).map((xs) => xs.map((x, i) => (i % 2 ? `- [ ] ${x}` : `- ${x}`)).join('\n')),
  fc.tuple(fc.constantFrom('', '<!--nitrogen:table style=zebra caption="Cap"-->\n', '<!--nitrogen:table widths=50,50-->\n'), words, words).map(([d, a, b]) => `${d}| ${a} | B |\n| :--- | ---: |\n| ${b} | [x](/index.md) |`),
  fc.tuple(fc.constantFrom('mermaid', 'ts', ''), words).map(([l, w]) => `\`\`\`${l}\n${w}\n\n${w}\n\`\`\``),
);

const quoted = (s: string) => s.split('\n').map((l) => (l ? `> ${l}` : '>')).join('\n');

const callout = fc
  .tuple(calloutType, fc.constantFrom('', '+', '-'), fc.oneof(fc.constant(''), words), fc.array(leafBlock, { minLength: 0, maxLength: 2 }))
  .map(([t, f, title, body]) => `> [!${t}]${f}${title ? ` ${title}` : ''}${body.length ? `\n${quoted(body.join('\n\n'))}` : ''}`);
const toggle = fc
  .tuple(words, fc.array(leafBlock, { minLength: 1, maxLength: 2 }), fc.boolean())
  .map(([s, body, open]) => `<details${open ? ' open' : ''}>\n<summary>${s}</summary>\n\n${body.join('\n\n')}\n\n</details>`);
const drawer = fc
  .tuple(words, fc.array(fc.oneof(leafBlock, callout), { minLength: 1, maxLength: 2 }))
  .map(([t, body]) => `:::drawer{title="${t}"}\n${body.join('\n\n')}\n:::`);
const drawerInCallout = fc.tuple(calloutType, words, words, para).map(([t, ti, dt, p]) => `> [!${t}] ${ti}\n${quoted(`:::drawer{title="${dt}"}\n${p}\n:::`)}`);

const block = fc.oneof({ weight: 5, arbitrary: leafBlock }, callout, toggle, drawer, drawerInCallout);
const frontmatter = fc.oneof(fc.constant(''), fc.tuple(words, fc.constantFrom('draft', 'active')).map(([t, s]) => `---\ntitle: ${t}\nstatus: ${s}\ntags: [a, b]\norder: 3\n---\n\n`));
const doc = fc.tuple(frontmatter, fc.array(block, { minLength: 1, maxLength: 8 })).map(([fm, bs]) => `${fm}# Title\n\n${bs.join('\n\n')}\n`);

const runs = Number(process.env.FC_RUNS ?? 150);

describe('property: normalization', () => {
  for (const profile of ['gfm', 'commonmark'] as const) {
    it(`is idempotent (${profile})`, () => {
      fc.assert(
        fc.property(doc, (d) => {
          const once = normalize(d, profile, ctx, { path: FIXTURE_PATH }).src;
          expect(normalize(once, profile, ctx, { path: FIXTURE_PATH }).src).toBe(once);
        }),
        { numRuns: runs },
      );
    });
    it(`preserves the semantic fingerprint (${profile})`, () => {
      fc.assert(
        fc.property(doc, (d) => {
          const out = normalize(d, profile, ctx, { path: FIXTURE_PATH }).src;
          const before = semanticFingerprint(autofix(d, ctx, { path: FIXTURE_PATH }).src, { path: FIXTURE_PATH, inlineFrontmatter: profile === 'commonmark' });
          expect(semanticFingerprint(out, { path: FIXTURE_PATH })).toEqual(before);
          expect(out).not.toMatch(/^\s*(?:>\s*)*:::drawer/m);
          expect(out).not.toMatch(/<!--\s*nitrogen:/);
          expect(out).not.toMatch(/\.svg#/);
        }),
        { numRuns: runs },
      );
    });
  }
  it('light scanner matches the full parser', () => {
    fc.assert(
      fc.property(doc, (d) => {
        expect(scanPage(d)).toEqual(parsePage(d).scan);
      }),
      { numRuns: runs },
    );
  });
});
