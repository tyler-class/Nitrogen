import { scanPage, lineStarts, locateInlineLink, offsetOf } from './light/scan.ts';
import { canonicalWikilink, resolveWikilink } from './resolve.ts';
import { canonicalImageFragment, splitImageSrc } from './syntax.ts';
import { isKebabFileName, kebabSuggestion, basename } from './paths.ts';
import type { Fix, VaultContext } from './types.ts';

export interface Edit {
  start: number;
  end: number;
  text: string;
}

/** Apply non-overlapping edits (any order). Overlapping edits throw. */
export function applyEdits(src: string, edits: Edit[]): string {
  const sorted = [...edits].sort((a, b) => a.start - b.start || a.end - b.end);
  let out = '';
  let pos = 0;
  for (const e of sorted) {
    if (e.start < pos) throw new Error(`Overlapping edits at ${e.start}`);
    out += src.slice(pos, e.start) + e.text;
    pos = e.end;
  }
  return out + src.slice(pos);
}

export interface AutofixOptions {
  path?: string;
}

/**
 * Safe, deterministic fixes: CRLF -> LF, single trailing newline, resolvable wikilinks ->
 * canonical links, canonical image fragment order. Also reports a kebab-case rename suggestion.
 */
export function autofix(src: string, ctx: VaultContext | null, opts: AutofixOptions = {}): { src: string; fixes: Fix[] } {
  const fixes: Fix[] = [];
  let out = src;
  if (out.includes('\r')) {
    out = out.replace(/\r\n?/g, '\n');
    fixes.push({ kind: 'line-endings', line: 0, before: 'CRLF', after: 'LF' });
  }
  const scan = scanPage(out);
  const starts = lineStarts(out);
  const edits: Edit[] = [];
  const path = opts.path ?? 'untitled.md';
  if (ctx) {
    for (const w of scan.wikilinks) {
      const res = resolveWikilink(w.target, ctx);
      const replacement = canonicalWikilink(w, res, path);
      if (!replacement) continue;
      const start = offsetOf(starts, w.line, w.col);
      if (out.slice(start, start + w.raw.length) !== w.raw) continue;
      edits.push({ start, end: start + w.raw.length, text: replacement });
      fixes.push({ kind: 'wikilink', line: w.line, before: w.raw, after: replacement });
    }
  }
  for (const img of scan.images) {
    const { fragment } = splitImageSrc(img.src);
    if (!fragment) continue;
    const canon = canonicalImageFragment(fragment);
    if (canon === fragment) continue;
    const start = offsetOf(starts, img.line, img.col);
    const loc = locateInlineLink(out, start);
    if (!loc) continue;
    const raw = out.slice(loc.urlStart, loc.urlEnd);
    const hash = raw.indexOf('#');
    if (hash < 0 || raw.slice(hash + 1) !== fragment) continue;
    edits.push({ start: loc.urlStart + hash + 1, end: loc.urlEnd, text: canon });
    fixes.push({ kind: 'image-fragment', line: img.line, before: fragment, after: canon });
  }
  out = applyEdits(out, edits);
  const trimmed = out.replace(/\n*$/, '\n');
  if (trimmed !== out && out.length > 0) {
    fixes.push({ kind: 'trailing-newline', line: 0, before: JSON.stringify(out.slice(-3)), after: '\\n' });
    out = trimmed;
  }
  if (opts.path && !isKebabFileName(opts.path) && basename(opts.path) !== 'index.md') {
    fixes.push({ kind: 'rename-suggestion', line: 0, before: opts.path, after: kebabSuggestion(opts.path) });
  }
  return { src: out, fixes };
}
