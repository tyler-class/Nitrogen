import { lineStarts, locateInlineLink, offsetOf, scanPage, stripQuote } from './light/scan.ts';
import { applyEdits, type Edit } from './autofix.ts';
import { isExternal, relativePath, resolvePath, splitHash } from './paths.ts';
import { encodeHref } from './resolve.ts';

const DEF_LINE_RE = /^(\s{0,3}(?:>\s?)*\s{0,3}\[[^\]^][^\]]*\]:\s*)(<[^>\n]*>|\S+)/;

function rewriteHref(href: string, fromPath: string, newFromPath: string, mapping: Map<string, string>): string | null {
  if (isExternal(href)) return null;
  const { path, hash } = splitHash(href);
  if (path === '') return null;
  const resolved = resolvePath(path, fromPath);
  if (resolved === null) return null;
  const target = mapping.get(resolved) ?? resolved;
  const rootRel = path.startsWith('/');
  if (target === resolved && (rootRel || newFromPath === fromPath)) return null;
  const newPath = rootRel ? `/${target}` : relativePath(newFromPath, target);
  return encodeHref(newPath) + (hash !== undefined ? `#${hash}` : '');
}

/**
 * Rewrite internal links and images after pages move. `mapping` maps old root-relative paths to
 * new ones. `fromPath` is where this page lives now (before the move); `newFromPath` is where it
 * will live (defaults to fromPath, or its mapped path).
 */
export function rewriteLinks(src: string, mapping: Map<string, string>, fromPath = 'index.md', newFromPath?: string): string {
  const dest = newFromPath ?? mapping.get(fromPath) ?? fromPath;
  const scan = scanPage(src);
  const starts = lineStarts(src);
  const edits: Edit[] = [];
  const seen = new Set<number>();
  for (const item of [...scan.links, ...scan.images]) {
    const off = offsetOf(starts, item.line, item.col);
    const loc = locateInlineLink(src, off);
    if (!loc || seen.has(loc.urlStart)) continue;
    seen.add(loc.urlStart);
    const raw = src.slice(loc.urlStart, loc.urlEnd);
    const next = rewriteHref(raw, fromPath, dest, mapping);
    if (next !== null && next !== raw) edits.push({ start: loc.urlStart, end: loc.urlEnd, text: next });
  }
  // Reference definitions.
  const lines = src.split('\n');
  let inFence = false;
  lines.forEach((l, i) => {
    const s = stripQuote(l).text;
    if (/^\s{0,3}(`{3,}|~{3,})/.test(s)) inFence = !inFence;
    if (inFence) return;
    const m = DEF_LINE_RE.exec(l);
    if (!m) return;
    let raw = m[2]!;
    let start = (starts[i] ?? 0) + m[1]!.length;
    if (raw.startsWith('<')) {
      raw = raw.slice(1, -1);
      start++;
    }
    const next = rewriteHref(raw, fromPath, dest, mapping);
    if (next !== null && next !== raw) edits.push({ start, end: start + raw.length, text: next });
  });
  return applyEdits(src, edits);
}

/** Paths of pages whose links point at `target` (from a list of [path, src]). */
export function findInbound(target: string, pages: { path: string; content: string }[]): string[] {
  const out: string[] = [];
  for (const p of pages) {
    const scan = scanPage(p.content);
    const hrefs = [...scan.links.map((l) => l.href), ...scan.images.map((i) => i.src)];
    const hits = hrefs.some((href) => {
      if (isExternal(href)) return false;
      const { path } = splitHash(href);
      return path !== '' && resolvePath(path, p.path) === target;
    });
    if (hits) out.push(p.path);
  }
  return out;
}

export interface MentionResult {
  src: string;
  line: number;
  matched: string;
}

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Turn the first eligible unlinked mention into a canonical link. Never inside code, headings,
 * existing links, HTML, or frontmatter. Preserves the original casing as link text. When `line`
 * is given, only that paragraph (the block containing that line) is considered.
 */
export function linkMention(src: string, mention: string, targetPath: string, opts: { line?: number } = {}): MentionResult | null {
  const scan = scanPage(src);
  const lines = src.split('\n');
  const starts = lineStarts(src);
  const re = new RegExp(`(?<![\\p{L}\\p{N}_])${escapeRe(mention)}(?![\\p{L}\\p{N}_])`, 'giu');
  // Ranges that are off-limits: existing links (whole inline span), wikilinks.
  const blocked: [number, number][] = [];
  for (const l of [...scan.links, ...scan.images]) {
    const off = offsetOf(starts, l.line, l.col);
    const loc = locateInlineLink(src, off);
    blocked.push([off, loc ? loc.end : off + ('text' in l ? l.text.length : l.alt.length) + 2]);
  }
  for (const w of scan.wikilinks) {
    const off = offsetOf(starts, w.line, w.col);
    blocked.push([off, off + w.raw.length]);
  }
  let range: [number, number] = [scan.frontmatter.lineCount, lines.length - 1];
  if (opts.line) {
    let a = opts.line - 1;
    let b = opts.line - 1;
    while (a - 1 >= scan.frontmatter.lineCount && stripQuote(lines[a - 1]!).text.trim() !== '') a--;
    while (b + 1 < lines.length && stripQuote(lines[b + 1]!).text.trim() !== '') b++;
    range = [a, b];
  }
  let inFence = false;
  let inHtml = false;
  for (let i = scan.frontmatter.lineCount; i < lines.length; i++) {
    const text = stripQuote(lines[i]!).text;
    if (/^\s{0,3}(`{3,}|~{3,})/.test(text)) {
      inFence = !inFence;
      continue;
    }
    if (inFence) continue;
    if (/^\s{0,3}<(?!https?:)/.test(text)) {
      inHtml = !/^\s*$/.test(text);
      continue;
    }
    if (text.trim() === '') {
      inHtml = false;
      continue;
    }
    if (inHtml) continue;
    if (i < range[0] || i > range[1]) continue;
    if (/^\s{0,3}#{1,6}(\s|$)/.test(text) || /^\s{0,3}:{3,}/.test(text) || /^\s{0,3}\[[^\]]+\]:/.test(text)) continue;
    if (i + 1 < lines.length && /^\s{0,3}(=+|-+)\s*$/.test(stripQuote(lines[i + 1]!).text) && !/\|/.test(text)) continue;
    const line = lines[i]!;
    // Mask code spans.
    const masked = line.replace(/(`+)[\s\S]*?\1/g, (m) => ' '.repeat(m.length));
    re.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = re.exec(masked))) {
      const abs = (starts[i] ?? 0) + m.index;
      if (blocked.some(([a, b]) => abs >= a && abs < b)) continue;
      // Skip text inside a callout marker title? Allowed: it's prose.
      const original = line.slice(m.index, m.index + m[0].length);
      const link = `[${original}](${encodeHref(`/${targetPath}`)})`;
      return { src: src.slice(0, abs) + link + src.slice(abs + original.length), line: i + 1, matched: original };
    }
  }
  return null;
}
