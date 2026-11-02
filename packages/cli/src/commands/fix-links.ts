import { mkdirSync, renameSync, writeFileSync, existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { checkPagePath, rewriteLinks } from '@nitrogen/core';
import { loadVault } from '../vault.ts';

export interface MovePlan {
  moves: { from: string; to: string }[];
  edits: { path: string; before: string; after: string }[];
}

/** Plan a page move: the move itself plus every link rewrite it needs. Pure. */
export function planMove(pages: { path: string; content: string }[], from: string, to: string): MovePlan {
  const mapping = new Map([[from, to]]);
  const edits: MovePlan['edits'] = [];
  for (const p of pages) {
    const after = rewriteLinks(p.content, mapping, p.path, p.path === from ? to : p.path);
    if (after !== p.content) edits.push({ path: p.path === from ? to : p.path, before: p.content, after });
  }
  return { moves: [{ from, to }], edits };
}

export function runFixLinks(opts: { root: string; move: [string, string]; dryRun?: boolean }, log: (s: string) => void = (s) => void process.stdout.write(`${s}\n`)): number {
  const [fromRaw, toRaw] = opts.move;
  const from = fromRaw.replace(/^\/+/, '');
  const to = toRaw.replace(/^\/+/, '');
  const v = loadVault(opts.root);
  if (!v.pages.some((p) => p.path === from)) {
    log(`${from} is not a page in this vault.`);
    return 1;
  }
  const check = checkPagePath(to, v.ctx.config.ignore);
  if (!check.ok) {
    log(`Cannot move to ${to}: ${check.reason}`);
    return 1;
  }
  if (existsSync(join(opts.root, to))) {
    log(`${to} already exists.`);
    return 1;
  }
  const plan = planMove(v.pages, from, to);
  log(`Move ${from} -> ${to}; ${plan.edits.length} file(s) need link updates.`);
  for (const e of plan.edits) log(`  ${e.path}`);
  if (opts.dryRun) return 0;
  mkdirSync(dirname(join(opts.root, to)), { recursive: true });
  renameSync(join(opts.root, from), join(opts.root, to));
  for (const e of plan.edits) {
    const target = join(opts.root, e.path);
    if (readFileSync(target, 'utf8') === e.before) writeFileSync(target, e.after);
  }
  log('Done.');
  return 0;
}
