/** Plain-text extraction shared by both modes (search body, excerpts, link context). */
import { splitFrontmatter } from './frontmatter.ts';
import { plainInline, stripQuote } from './light/scan.ts';
import { parseAttributes, parseCalloutMarker } from './syntax.ts';

const FENCE_RE = /^\s{0,3}(`{3,}|~{3,})/;

/** Convert one markdown line to plain text (container markers removed). */
export function plainLine(line: string): string {
  let l = stripQuote(line).text;
  const callout = parseCalloutMarker(l.trim());
  if (callout) return callout.title;
  const drawer = /^\s{0,3}:{3,}\s*drawer\s*(\{[^}]*\})?\s*$/.exec(l);
  if (drawer) return drawer[1] ? (parseAttributes(drawer[1].slice(1, -1)).title ?? '') : '';
  if (/^\s{0,3}:{3,}\s*$/.test(l)) return '';
  if (/^\s{0,3}<!--/.test(l)) return '';
  l = l.replace(/^\s{0,3}#{1,6}\s+/, '').replace(/\s+#+\s*$/, '');
  l = l.replace(/^\s*(?:[-+*]|\d{1,9}[.)])\s+(?:\[[ xX]\]\s+)?/, '');
  l = l.replace(/^\s{0,3}\[\^[^\]]+\]:\s*/, '');
  if (/^\|?\s*:?-+:?\s*(\|\s*:?-+:?\s*)*\|?\s*$/.test(l) && l.includes('-')) return '';
  if (l.includes('|')) l = l.replace(/^\s*\|/, '').replace(/\|\s*$/, '').replace(/(?<!\\)\|/g, ' ');
  return plainInline(l).replace(/\s+/g, ' ').trim();
}

/** Body text for full-text search: everything except frontmatter and markup. Code is kept. */
export function bodyText(src: string): string {
  const { body } = splitFrontmatter(src);
  const out: string[] = [];
  let inFence = false;
  for (const raw of body.split('\n')) {
    if (FENCE_RE.test(stripQuote(raw).text)) {
      inFence = !inFence;
      continue;
    }
    const t = inFence ? raw.trim() : plainLine(raw);
    if (t) out.push(t);
  }
  return out.join('\n');
}

/** First paragraph of prose (no headings, code, tables, callout markers), max `max` chars. */
export function excerpt(src: string, max = 200): string {
  const { body } = splitFrontmatter(src);
  let inFence = false;
  const para: string[] = [];
  for (const raw of body.split('\n')) {
    const s = stripQuote(raw).text;
    if (FENCE_RE.test(s)) {
      inFence = !inFence;
      if (para.length) break;
      continue;
    }
    if (inFence) continue;
    const trimmed = s.trim();
    if (!trimmed) {
      if (para.length) break;
      continue;
    }
    if (/^#{1,6}\s/.test(trimmed) || /^</.test(trimmed) || /^:::/.test(trimmed) || /^\|/.test(trimmed) || parseCalloutMarker(trimmed)) {
      if (para.length) break;
      continue;
    }
    const t = plainLine(raw);
    if (t) para.push(t);
  }
  return truncate(para.join(' '), max);
}

export function truncate(s: string, max: number): string {
  if (s.length <= max) return s;
  const cut = s.slice(0, max - 1);
  const sp = cut.lastIndexOf(' ');
  return `${(sp > max * 0.6 ? cut.slice(0, sp) : cut).trimEnd()}…`;
}

/**
 * Context for a link on `line` (1-based): the surrounding block of non-blank lines, as plain
 * text, max 240 chars, centered on `needle` when the paragraph is longer.
 */
export function contextAt(lines: string[], line: number, needle = '', max = 240): string {
  const idx = line - 1;
  const isBoundary = (l: string | undefined) => {
    if (l === undefined) return true;
    const s = stripQuote(l).text.trim();
    return s === '' || /^#{1,6}\s/.test(s) || FENCE_RE.test(s) || /^:::/.test(s) || /^<\/?details|^<summary/i.test(s) || /^\s*(?:[-+*]|\d{1,9}[.)])\s/.test(stripQuote(l).text) || !!parseCalloutMarker(s);
  };
  const cur = lines[idx] ?? '';
  // Headings, list items and table rows are their own context.
  const curText = stripQuote(cur).text;
  let from = idx;
  let to = idx;
  const own = /^\s{0,3}#{1,6}\s/.test(curText) || curText.includes('|') || /^\s*(?:[-+*]|\d{1,9}[.)])\s/.test(curText);
  if (!own) {
    while (from - 1 >= 0 && !isBoundary(lines[from - 1])) from--;
    while (to + 1 < lines.length && !isBoundary(lines[to + 1]) && !/^\s*(?:[-+*]|\d{1,9}[.)])\s/.test(stripQuote(lines[to + 1]!).text)) to++;
  } else if (/^\s*(?:[-+*]|\d{1,9}[.)])\s/.test(curText)) {
    while (to + 1 < lines.length && !isBoundary(lines[to + 1]) && /^\s{2,}\S/.test(stripQuote(lines[to + 1]!).text)) to++;
  }
  const text = lines
    .slice(from, to + 1)
    .map(plainLine)
    .filter(Boolean)
    .join(' ')
    .replace(/\s+/g, ' ')
    .trim();
  if (text.length <= max) return text;
  const at = needle ? text.indexOf(needle) : -1;
  if (at < 0) return truncate(text, max);
  const startAt = Math.max(0, Math.min(at - Math.floor((max - needle.length) / 2), text.length - max));
  const slice = text.slice(startAt, startAt + max);
  return `${startAt > 0 ? '…' : ''}${slice.slice(startAt > 0 ? 1 : 0, startAt + max < text.length ? -1 : undefined)}${startAt + max < text.length ? '…' : ''}`;
}
