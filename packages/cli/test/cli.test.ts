import { describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { cpSync, mkdtempSync, readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHmac } from 'node:crypto';
import { gitBlobSha, planMove, signIngest, buildIndex } from '../src/index.ts';
import { runExport } from '../src/commands/export.ts';
import { runLint } from '../src/commands/lint.ts';
import { runFixLinks } from '../src/commands/fix-links.ts';

const demo = join(import.meta.dirname, '../../../examples/notes-repo');
const quiet = () => {};
const sink = { write: () => true };

function tmpVault(): string {
  const d = mkdtempSync(join(tmpdir(), 'n2-'));
  cpSync(demo, d, { recursive: true });
  return d;
}

describe('cli', () => {
  it('gitBlobSha matches git hash-object', () => {
    const f = join(demo, 'index.md');
    expect(gitBlobSha(readFileSync(f, 'utf8'))).toBe(execFileSync('git', ['hash-object', f], { encoding: 'utf8' }).trim());
  });

  it('signs ingest bodies with a timestamped HMAC', () => {
    expect(signIngest('s', '1', '{}')).toBe(createHmac('sha256', 's').update('1.{}').digest('hex'));
  });

  it('lints the demo vault clean and fails on errors', () => {
    expect(runLint([], { root: demo, format: 'text' }, sink)).toBe(0);
    const d = tmpVault();
    writeFileSync(join(d, 'bad.md'), '# Bad\n\n![](/images/2026/11/atom.svg)\n');
    expect(runLint([], { root: d, format: 'json' }, sink)).toBe(1);
  });

  it('exports the demo vault with relative links and copied images', () => {
    const out = mkdtempSync(join(tmpdir(), 'n2-exp-'));
    expect(runExport({ root: demo, out, profile: 'commonmark' }, quiet)).toBe(0);
    expect(existsSync(join(out, 'assets/2026/11/atom.svg'))).toBe(true);
    const tour = readFileSync(join(out, 'welcome/format-tour.md'), 'utf8');
    expect(tour).toContain('](../assets/2026/11/n2.svg "Figure 1: dinitrogen")');
    expect(tour).toContain('[Home](../index.md)');
    expect(tour).not.toMatch(/:::|<!--nitrogen|#align=|<details|<kbd/);
  });

  it('plans and applies a move with inbound link rewrites', () => {
    const d = tmpVault();
    const plan = planMove([
      { path: 'a.md', content: '[s](/architecture/sync-design.md#polling)' },
      { path: 'architecture/sync-design.md', content: '[up](index.md)' },
    ], 'architecture/sync-design.md', 'design/sync.md');
    expect(plan.edits).toEqual([
      { path: 'a.md', before: '[s](/architecture/sync-design.md#polling)', after: '[s](/design/sync.md#polling)' },
      { path: 'design/sync.md', before: '[up](index.md)', after: '[up](../architecture/index.md)' },
    ]);
    expect(runFixLinks({ root: d, move: ['architecture/sync-design.md', 'design/sync.md'] }, quiet)).toBe(0);
    expect(existsSync(join(d, 'design/sync.md'))).toBe(true);
    expect(readFileSync(join(d, 'welcome/format-tour.md'), 'utf8')).toContain('(/design/sync.md#commit-flow "rel:cites")');
    expect(runLint([], { root: d, format: 'text' }, sink)).toBe(0);
  });

  it('refuses moves into reserved folders', () => {
    const d = tmpVault();
    mkdirSync(join(d, 'x'), { recursive: true });
    expect(runFixLinks({ root: d, move: ['index.md', '.github/x.md'] }, quiet)).toBe(1);
  });

  it('builds index rows for every page', () => {
    const { rows } = buildIndex(demo);
    expect(rows.map((r) => r.page.path)).toContain('welcome/format-tour.md');
    const tour = rows.find((r) => r.page.path === 'welcome/format-tour.md')!;
    expect(tour.links.map((l) => [l.dst, l.rel])).toContainEqual(['decisions/adr-004-direct-commits.md', 'implements']);
  });
});
