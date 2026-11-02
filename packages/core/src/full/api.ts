import { parsePage } from './parse.ts';
import { lintScan, type LintOptions } from '../lint.ts';
import { indexRowsFromScan, type IndexRows } from '../indexer.ts';
import type { Diagnostic, VaultContext } from '../types.ts';

/** Lint with the full parser. */
export function lintPage(src: string, ctx: VaultContext | null, opts: LintOptions = {}): Diagnostic[] {
  return lintScan(parsePage(src).scan, src, ctx, opts);
}

/** Index rows with the full parser. */
export function extractIndexRows(path: string, src: string, sha: string, ctx: VaultContext | null = null): IndexRows {
  return indexRowsFromScan(path, src, sha, parsePage(src).scan, ctx);
}
