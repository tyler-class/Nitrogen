/**
 * Light mode: a dependency-light line scanner that extracts the same PageScan as the full parser,
 * cheaply enough for a Cloudflare Worker request. It is not a CommonMark parser; it understands
 * exactly the constructs Nitrogen indexes and lints. Parity with the full parser is enforced by
 * tests over the conformance fixtures.
 */
import { parseFrontmatter } from '../frontmatter.ts';
import { createSlugger } from '../slug.ts';
import {
  findTags,
  parseAttributes,
  parseCalloutMarker,
  parseRel,
  parseTableDirective,
  scanToggleLayout,
} from '../syntax.ts';
import { isExternal } from '../paths.ts';
import type { DrawerInfo, PageScan } from '../types.ts';

interface Seg {
  /** Text of the line after container prefixes and leading spaces. */
  text: string;
  /** 0-based line index. */
  line: number;
  /** Characters removed before `text` on that line. */
  offset: number;
}

const HTML6 =
  'address|article|aside|base|basefont|blockquote|body|caption|center|col|colgroup|dd|details|dialog|dir|div|dl|dt|fieldset|figcaption|figure|footer|form|frame|frameset|h1|h2|h3|h4|h5|h6|head|header|hr|html|iframe|legend|li|link|main|menu|menuitem|nav|noframes|ol|optgroup|option|p|param|search|section|summary|table|tbody|td|tfoot|th|thead|title|tr|track|ul';
const HTML6_RE = new RegExp(`^\\s{0,3}</?(?:${HTML6})(?:\\s|/?>|$)`, 'i');
const HTML1_RE = /^\s{0,3}<(script|pre|style|textarea)(?:\s|>|$)/i;
const HTML7_RE = /^\s{0,3}(?:<[A-Za-z][A-Za-z0-9-]*(?:\s+[A-Za-z_:][\w.:-]*(?:\s*=\s*(?:"[^"]*"|'[^']*'|[^\s"'=<>`]+))?)*\s*\/?>|<\/[A-Za-z][A-Za-z0-9-]*\s*>)\s*$/;
const FENCE_RE = /^(\s{0,3})(`{3,}|~{3,})(.*)$/;
const ATX_RE = /^\s{0,3}(#{1,6})(?:[ \t]+(.*?))?(?:[ \t]+#+)?[ \t]*$/;
const SETEXT_RE = /^\s{0,3}(=+|-+)[ \t]*$/;
const HR_RE = /^\s{0,3}([-*_])(?:[ \t]*\1){2,}[ \t]*$/;
const LIST_RE = /^(\s*)([-+*]|\d{1,9}[.)])([ \t]+|$)(.*)$/;
const DEF_RE = /^\s{0,3}\[([^\]^][^\]]*)\]:\s*(<[^>\n]*>|\S+)(?:\s+("[^"]*"|'[^']*'|\([^)]*\)))?\s*$/;
const DIRECTIVE_OPEN_RE = /^\s{0,3}(:{3,})\s*([A-Za-z][\w-]*)\s*(?:\[[^\]]*\])?\s*(\{[^}]*\})?\s*$/;
const DIRECTIVE_CLOSE_RE = /^\s{0,3}(:{3,})\s*$/;
const DELIM_ROW_RE = /^\|?\s*:?-+:?\s*(?:\|\s*:?-+:?\s*)*\|?\s*$/;

export function normalizeLabel(s: string): string {
  return s.trim().replace(/\s+/g, ' ').toLowerCase();
}

function unescapeMd(s: string): string {
  return s
    .replace(/\\([!-/:-@[-`{-~])/g, '$1')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"');
}

/** Strip inline markdown to plain text (mirrors nodeText of the full parser on common input). */
export function plainInline(s: string): string {
  let t = s;
  t = t.replace(/`+([^`]|[^`][\s\S]*?[^`])`+/g, (_m, c: string) => `\u0000${c.trim() === '' ? c : c.replace(/^ (.*) $/s, '$1')}\u0001`);
  t = t.replace(/!\[([^\]]*)\]\([^)]*\)/g, '$1');
  t = t.replace(/!\[([^\]]*)\]\[[^\]]*\]/g, '$1');
  t = t.replace(/\[([^\]]*)\]\((?:[^()\s]|\([^)]*\))*(?:\s+(?:"[^"]*"|'[^']*'))?\s*\)/g, '$1');
  t = t.replace(/\[([^\]]*)\]\[[^\]]*\]/g, '$1');
  t = t.replace(/<([A-Za-z][A-Za-z0-9+.-]{1,31}:[^\s<>]*)>/g, '$1');
  t = t.replace(/<!--[\s\S]*?-->|<\/?[A-Za-z][A-Za-z0-9-]*(?:\s[^<>]*)?\/?>/g, '');
  t = t.replace(/~~/g, '').replace(/\*+/g, '');
  t = t.replace(/(^|[^\p{L}\p{N}])_+(?=[\p{L}\p{N}])/gu, '$1').replace(/([\p{L}\p{N}])_+(?=[^\p{L}\p{N}]|$)/gu, '$1');
  t = t.replace(/(^|[^\p{L}\p{N}])_+(?=[^\p{L}\p{N}]|$)/gu, '$1');
  t = unescapeMd(t);
  // Restore code spans verbatim.
  t = t.replace(/\u0000([\s\S]*?)\u0001/g, '$1');
  return t;
}

interface Def {
  url: string;
  title?: string;
}

export function scanPage(src: string): PageScan {
  const frontmatter = parseFrontmatter(src);
  const scan: PageScan = {
    frontmatter,
    headings: [],
    links: [],
    images: [],
    wikilinks: [],
    callouts: [],
    drawers: [],
    tableDirectives: [],
    html: [],
    toggles: [],
  };
  const lines = src.split('\n').map((l) => l.replace(/\r$/, ''));
  const slugger = createSlugger();
  const codeLines = new Set<number>();
  const start = frontmatter.lineCount;

  // Pass 1: reference definitions (outside fences).
  const defs = new Map<string, Def>();
  {
    let fence: { ch: string; len: number } | null = null;
    for (let i = start; i < lines.length; i++) {
      const c = stripQuote(lines[i]!).text;
      if (fence) {
        const m = FENCE_RE.exec(c);
        if (m && m[2]![0] === fence.ch && m[2]!.length >= fence.len && m[3]!.trim() === '') fence = null;
        continue;
      }
      const f = FENCE_RE.exec(c);
      if (f && !(f[2]![0] === '`' && f[3]!.includes('`'))) {
        fence = { ch: f[2]![0]!, len: f[2]!.length };
        continue;
      }
      const d = DEF_RE.exec(c);
      if (d) {
        const label = normalizeLabel(d[1]!);
        let url = d[2]!;
        if (url.startsWith('<')) url = url.slice(1, -1);
        const def: Def = { url: unescapeMd(url) };
        if (d[3]) def.title = unescapeMd(d[3].slice(1, -1));
        if (!defs.has(label)) defs.set(label, def);
      }
    }
  }

  let para: Seg[] = [];
  let paraIsTable = false;
  let fence: { ch: string; len: number; q: number } | null = null;
  let html: { endRe: RegExp | null } | null = null;
  let prevQ = 0;
  const quoteKinds: ('callout' | 'blockquote')[] = [];
  const containers: { len: number; kind: 'drawer' | 'other' }[] = [];
  let toggleDepth = 0;
  let inList = false;
  let lastBlank = true;

  const pushHtmlTags = (text: string, line: number, offset: number) => {
    for (const t of findTags(text)) {
      scan.html.push({ tag: t.tag, closing: t.closing, line: line + 1, col: offset + t.index + 1, attrs: t.attrs });
    }
  };

  const flush = () => {
    if (para.length === 0) return;
    if (paraIsTable) para.forEach((s) => scanInlineSegs([s], scan, defs, false));
    else scanInlineSegs(para, scan, defs, true);
    para = [];
    paraIsTable = false;
  };

  for (let i = start; i < lines.length; i++) {
    const raw = lines[i]!;
    const sq = stripQuote(raw);
    const q = sq.depth;
    let c = sq.text;
    let offset = raw.length - c.length;

    // Fenced code.
    if (fence) {
      const m = FENCE_RE.exec(c);
      codeLines.add(i);
      if ((m && m[2]![0] === fence.ch && m[2]!.length >= fence.len && m[3]!.trim() === '') || q < fence.q) {
        if (q < fence.q && !(m && m[2]![0] === fence.ch)) codeLines.delete(i);
        else {
          fence = null;
          continue;
        }
        fence = null;
      } else continue;
    }

    // HTML block.
    if (html) {
      if (html.endRe === null && c.trim() === '') {
        html = null;
      } else {
        pushHtmlTags(c, i, offset);
        if (q === 0 && containers.length === 0 && !inList) toggleDepth = Math.max(0, toggleDepth + toggleDelta(c));
        if (html.endRe && html.endRe.test(c)) html = null;
        continue;
      }
    }

    if (c.trim() === '') {
      flush();
      if (q === 0) {
        prevQ = 0;
        quoteKinds.length = 0;
      }
      lastBlank = true;
      continue;
    }

    // Lazy continuation of a quoted paragraph.
    if (q < prevQ && para.length > 0 && !paraIsTable && q === 0 && !FENCE_RE.test(c) && !ATX_RE.test(c) && !HR_RE.test(c) && !DIRECTIVE_CLOSE_RE.test(c)) {
      const lead = c.length - c.trimStart().length;
      para.push({ text: c.trim(), line: i, offset: offset + lead });
      lastBlank = false;
      continue;
    }

    // Blockquote starts.
    if (q > prevQ) {
      flush();
      for (let d = prevQ; d < q; d++) quoteKinds[d] = 'blockquote';
      const marker = parseCalloutMarker(c.trim());
      if (marker && sq.explicit) {
        scan.callouts.push({ ...marker, line: i + 1 });
        quoteKinds[q - 1] = 'callout';
      }
    } else if (q < prevQ) {
      flush();
      quoteKinds.length = q;
    }
    prevQ = q;

    // List items.
    const lm = LIST_RE.exec(c);
    let listItem = false;
    if (lm && !HR_RE.test(c)) {
      flush();
      listItem = true;
      inList = true;
      const markerLen = lm[1]!.length + lm[2]!.length + lm[3]!.length;
      offset += markerLen;
      c = lm[4]!;
      const task = /^\[[ xX]\][ \t]+/.exec(c);
      if (task) {
        offset += task[0].length;
        c = c.slice(task[0].length);
      }
      if (c.trim() === '') {
        lastBlank = false;
        continue;
      }
    } else if (inList && lastBlank && !/^\s/.test(c)) {
      inList = false;
    }

    // Indented code.
    if (!inList && para.length === 0 && /^(?: {4}|\t)/.test(c)) {
      codeLines.add(i);
      lastBlank = false;
      continue;
    }
    const lead = c.length - c.trimStart().length;
    const isIndentedCont = inList && lead >= 2;
    const cc = isIndentedCont ? c.trimStart() : c;
    const ccOffset = isIndentedCont ? offset + lead : offset;

    const f = FENCE_RE.exec(cc);
    if (f && !(f[2]![0] === '`' && f[3]!.includes('`'))) {
      flush();
      fence = { ch: f[2]![0]!, len: f[2]!.length, q };
      codeLines.add(i);
      lastBlank = false;
      continue;
    }

    // Directives.
    const dOpen = DIRECTIVE_OPEN_RE.exec(cc);
    if (dOpen) {
      flush();
      const name = dOpen[2]!;
      if (name === 'drawer') {
        let parent: DrawerInfo['parent'];
        if (containers.some((x) => x.kind === 'drawer')) parent = 'drawer';
        else if (listItem || isIndentedCont) parent = 'list';
        else if (containers.length > 0) parent = 'other';
        else if (q > 0) parent = quoteKinds[q - 1] === 'callout' ? 'callout' : 'blockquote';
        else parent = toggleDepth > 0 ? 'toggle' : 'root';
        scan.drawers.push({ attrs: dOpen[3] ? parseAttributes(dOpen[3].slice(1, -1)) : {}, line: i + 1, parent });
      }
      containers.push({ len: dOpen[1]!.length, kind: name === 'drawer' ? 'drawer' : 'other' });
      lastBlank = false;
      continue;
    }
    const dClose = DIRECTIVE_CLOSE_RE.exec(cc);
    if (dClose && containers.length > 0) {
      flush();
      const n = dClose[1]!.length;
      while (containers.length > 0 && containers[containers.length - 1]!.len <= n) containers.pop();
      lastBlank = false;
      continue;
    }

    // HTML blocks.
    const t1 = HTML1_RE.exec(cc);
    const isComment = /^\s{0,3}<!--/.test(cc);
    if (t1 || isComment || HTML6_RE.test(cc) || (para.length === 0 && HTML7_RE.test(cc))) {
      flush();
      pushHtmlTags(cc, i, ccOffset);
      if (q === 0 && containers.length === 0 && !inList) toggleDepth = Math.max(0, toggleDepth + toggleDelta(cc));
      let endRe: RegExp | null = null;
      if (t1) endRe = new RegExp(`</${t1[1]}>`, 'i');
      else if (isComment) endRe = /-->/;
      if (isComment) {
        // Table directive: collect the whole comment then look at the following lines.
        let j = i;
        let text = cc;
        while (!/-->/.test(text) && j + 1 < lines.length) {
          j++;
          text += `\n${stripQuote(lines[j]!).text}`;
        }
        const attrs = parseTableDirective(text);
        if (attrs) {
          const h = lines[j + 1] !== undefined ? stripQuote(lines[j + 1]!).text : undefined;
          const d = lines[j + 2] !== undefined ? stripQuote(lines[j + 2]!).text : undefined;
          let columns: number | null = null;
          if (h !== undefined && d !== undefined && h.includes('|') && DELIM_ROW_RE.test(d) && d.includes('-')) {
            columns = splitRow(d).length;
          }
          scan.tableDirectives.push({ attrs, line: i + 1, columns });
        }
      }
      if (endRe && endRe.test(cc)) {
        lastBlank = false;
        continue;
      }
      html = { endRe };
      lastBlank = false;
      continue;
    }

    // ATX headings.
    const atx = ATX_RE.exec(cc);
    if (atx) {
      flush();
      const content = atx[2] ?? '';
      const text = plainInline(content).trim();
      scan.headings.push({ level: atx[1]!.length, text, slug: slugger.slug(text), line: i + 1 });
      const at = cc.indexOf(content, atx[1]!.length);
      scanInlineSegs([{ text: content, line: i, offset: ccOffset + Math.max(at, 0) }], scan, defs, false);
      lastBlank = false;
      continue;
    }

    // Setext headings.
    if (para.length > 0 && !paraIsTable && !listItem && SETEXT_RE.test(cc)) {
      const m = SETEXT_RE.exec(cc)!;
      const text = plainInline(para.map((s) => s.text).join('\n')).trim();
      scan.headings.push({ level: m[1]![0] === '=' ? 1 : 2, text, slug: slugger.slug(text), line: para[0]!.line + 1 });
      scanInlineSegs(para, scan, defs, false);
      para = [];
      lastBlank = false;
      continue;
    }

    if (HR_RE.test(cc)) {
      flush();
      lastBlank = false;
      continue;
    }

    // Reference definitions are not content.
    if (para.length === 0 && DEF_RE.test(cc)) {
      lastBlank = false;
      continue;
    }

    // Footnote definition: drop the label.
    let text = cc;
    let off = ccOffset;
    const fn = /^\s{0,3}\[\^[^\]]+\]:\s*/.exec(text);
    if (fn) {
      flush();
      off += fn[0].length;
      text = text.slice(fn[0].length);
    }

    // Tables: a header row followed by a delimiter row.
    const next = lines[i + 1] !== undefined ? stripQuote(lines[i + 1]!).text : undefined;
    const startsTable = text.includes('|') && next !== undefined && DELIM_ROW_RE.test(next) && next.includes('-');
    if (startsTable && (para.length === 0 || !paraIsTable)) {
      flush();
      paraIsTable = true;
    }
    if (paraIsTable && DELIM_ROW_RE.test(text) && text.includes('-')) {
      lastBlank = false;
      continue;
    }
    if (paraIsTable && !text.includes('|') && !startsTable) {
      // A table ends at a line without pipes; this line starts a paragraph.
      flush();
    }

    const l2 = text.length - text.trimStart().length;
    para.push({ text: text.trim(), line: i, offset: off + l2 });
    lastBlank = false;
  }
  flush();
  scan.toggles = scanToggleLayout(lines, (i) => codeLines.has(i) || i < start, (l) => stripQuote(l).text).map((t) => ({
    line: t.line,
    missingBlankLines: t.missing,
    summary: t.summary,
  }));
  const byPos = (a: { line: number; col: number }, b: { line: number; col: number }) => a.line - b.line || a.col - b.col;
  scan.links.sort(byPos);
  scan.images.sort(byPos);
  scan.html.sort(byPos);
  return scan;
}

function toggleDelta(s: string): number {
  let d = 0;
  for (const t of findTags(s)) if (t.tag === 'details') d += t.closing ? -1 : 1;
  return d;
}

function splitRow(row: string): string[] {
  let r = row.trim();
  if (r.startsWith('|')) r = r.slice(1);
  if (r.endsWith('|') && !r.endsWith('\\|')) r = r.slice(0, -1);
  return r.split(/(?<!\\)\|/);
}

export function stripQuote(l: string): { text: string; depth: number; explicit: boolean } {
  let depth = 0;
  let rest = l;
  for (;;) {
    const m = /^\s{0,3}>\s?/.exec(rest);
    if (!m) break;
    depth++;
    rest = rest.slice(m[0].length);
  }
  return { text: rest, depth, explicit: depth > 0 };
}

// ---------- inline scanning ----------

function scanInlineSegs(segs: Seg[], scan: PageScan, defs: Map<string, Def>, isParagraph: boolean): void {
  const text = segs.map((s) => s.text).join('\n');
  const starts: number[] = [];
  let acc = 0;
  for (const s of segs) {
    starts.push(acc);
    acc += s.text.length + 1;
  }
  const pos = (idx: number) => {
    let k = 0;
    while (k + 1 < starts.length && starts[k + 1]! <= idx) k++;
    const seg = segs[k]!;
    return { line: seg.line + 1, col: seg.offset + (idx - starts[k]!) + 1 };
  };
  const imagesBefore = scan.images.length;
  scanInline(text, 0, text.length, false, scan, defs, pos);
  if (isParagraph && scan.images.length === imagesBefore + 1) {
    const img = scan.images[imagesBefore]!;
    img.standalone = isOnlyImage(text);
  }
}

function isOnlyImage(text: string): boolean {
  const t = text.trim();
  if (!t.startsWith('![')) return false;
  const end = matchBracket(t, 1);
  if (end < 0) return false;
  if (t[end + 1] === '(') {
    const d = parseDestination(t, end + 2);
    return d !== null && d.end === t.length;
  }
  return false;
}

/** Index of the `]` matching the `[` at `open`, or -1. */
function matchBracket(t: string, open: number): number {
  let depth = 0;
  for (let i = open; i < t.length; i++) {
    const ch = t[i];
    if (ch === '\\') {
      i++;
      continue;
    }
    if (ch === '`') {
      const run = backtickRun(t, i);
      const close = findBacktickClose(t, i + run, run);
      if (close >= 0) {
        i = close + run - 1;
        continue;
      }
      i += run - 1;
      continue;
    }
    if (ch === '[') depth++;
    else if (ch === ']') {
      depth--;
      if (depth === 0) return i;
    }
  }
  return -1;
}

function backtickRun(t: string, i: number): number {
  let n = 0;
  while (t[i + n] === '`') n++;
  return n;
}

function findBacktickClose(t: string, from: number, run: number): number {
  for (let j = from; j < t.length; j++) {
    if (t[j] === '`') {
      const r = backtickRun(t, j);
      if (r === run) return j;
      j += r - 1;
    }
  }
  return -1;
}

interface Dest {
  url: string;
  title?: string;
  end: number;
  rawStart: number;
  rawEnd: number;
  angle: boolean;
}

function parseDestination(t: string, i: number): Dest | null {
  let p = i;
  const ws = () => {
    let nl = 0;
    while (p < t.length && /\s/.test(t[p]!)) {
      if (t[p] === '\n' && ++nl > 1) return false;
      p++;
    }
    return true;
  };
  if (!ws()) return null;
  let url: string;
  let rawStart = p;
  let rawEnd: number;
  const angle = t[p] === '<';
  if (angle) {
    const close = t.indexOf('>', p);
    if (close < 0 || t.slice(p, close).includes('\n')) return null;
    url = t.slice(p + 1, close);
    rawStart = p + 1;
    rawEnd = close;
    p = close + 1;
  } else {
    let depth = 0;
    const s = p;
    while (p < t.length) {
      const ch = t[p]!;
      if (ch === '\\') {
        p += 2;
        continue;
      }
      if (/\s/.test(ch)) break;
      if (ch === '(') depth++;
      else if (ch === ')') {
        if (depth === 0) break;
        depth--;
      }
      p++;
    }
    url = t.slice(s, p);
    rawEnd = p;
  }
  const beforeWs = p;
  if (!ws()) return null;
  let title: string | undefined;
  const q = t[p];
  if ((q === '"' || q === "'" || q === '(') && p > beforeWs) {
    const closeCh = q === '(' ? ')' : q;
    let k = p + 1;
    while (k < t.length && t[k] !== closeCh) {
      if (t[k] === '\\') k++;
      k++;
    }
    if (k >= t.length) return null;
    title = unescapeMd(t.slice(p + 1, k));
    p = k + 1;
    if (!ws()) return null;
  }
  if (t[p] !== ')') return null;
  const out: Dest = { url: unescapeMd(url), end: p + 1, rawStart, rawEnd, angle };
  if (title !== undefined) out.title = title;
  return out;
}

/**
 * Locate the destination of an inline link or image starting at `offset` (the `[` or `!`).
 * Returns raw source offsets of the URL, or null for reference-style links.
 */
export function locateInlineLink(src: string, offset: number): { urlStart: number; urlEnd: number; end: number; angle: boolean } | null {
  const open = src[offset] === '!' ? offset + 1 : offset;
  if (src[open] !== '[') return null;
  const close = matchBracket(src, open);
  if (close < 0 || src[close + 1] !== '(') return null;
  const d = parseDestination(src, close + 2);
  if (!d) return null;
  return { urlStart: d.rawStart, urlEnd: d.rawEnd, end: d.end, angle: d.angle };
}

/** Offsets of each line start, for line/col to offset mapping. */
export function lineStarts(src: string): number[] {
  const out = [0];
  for (let i = 0; i < src.length; i++) if (src[i] === '\n') out.push(i + 1);
  return out;
}

export function offsetOf(starts: number[], line: number, col: number): number {
  return (starts[line - 1] ?? 0) + col - 1;
}

const WIKI_STICKY = /\[\[([^[\]\n|#]*?)(?:#([^[\]\n|]*?))?(?:\|([^[\]\n]*?))?\]\]/y;
const AUTOLINK_STICKY = /<([A-Za-z][A-Za-z0-9+.-]{1,31}:[^\s<>]*)>/y;
const EMAIL_STICKY = /<([A-Za-z0-9.!#$%&'*+/=?^_`{|}~-]+@[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?(?:\.[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?)*)>/y;
const TAG_STICKY = /<!--[\s\S]*?-->|<\/?[A-Za-z][A-Za-z0-9-]*(?:\s+[A-Za-z_:][\w.:-]*(?:\s*=\s*(?:"[^"]*"|'[^']*'|[^\s"'=<>`]+))?)*\s*\/?>/y;

function scanInline(
  t: string,
  from: number,
  to: number,
  inLink: boolean,
  scan: PageScan,
  defs: Map<string, Def>,
  pos: (i: number) => { line: number; col: number },
): void {
  let i = from;
  while (i < to) {
    const ch = t[i]!;
    if (ch === '\\') {
      i += 2;
      continue;
    }
    if (ch === '`') {
      const run = backtickRun(t, i);
      const close = findBacktickClose(t, i + run, run);
      i = close >= 0 && close < to ? close + run : i + run;
      continue;
    }
    if (ch === '<') {
      AUTOLINK_STICKY.lastIndex = i;
      const a = AUTOLINK_STICKY.exec(t);
      if (a) {
        if (!inLink) {
          const p = pos(i);
          scan.links.push({ href: a[1]!, text: a[1]!, rel: 'related', relExplicit: false, ...p, external: true });
        }
        i += a[0].length;
        continue;
      }
      EMAIL_STICKY.lastIndex = i;
      const e = EMAIL_STICKY.exec(t);
      if (e) {
        if (!inLink) scan.links.push({ href: `mailto:${e[1]}`, text: e[1]!, rel: 'related', relExplicit: false, ...pos(i), external: true });
        i += e[0].length;
        continue;
      }
      TAG_STICKY.lastIndex = i;
      const tag = TAG_STICKY.exec(t);
      if (tag) {
        const p = pos(i);
        for (const ft of findTags(tag[0])) scan.html.push({ tag: ft.tag, closing: ft.closing, line: p.line, col: p.col, attrs: ft.attrs });
        i += tag[0].length;
        continue;
      }
      i++;
      continue;
    }
    if (ch === '[' && t[i + 1] === '[') {
      WIKI_STICKY.lastIndex = i;
      const w = WIKI_STICKY.exec(t);
      if (w && (w[1]!.trim() || w[2]?.trim())) {
        if (!inLink) {
          const info: PageScan['wikilinks'][number] = { raw: w[0], target: w[1]!.trim(), ...pos(i) };
          if (w[2]?.trim()) info.anchor = w[2].trim();
          if (w[3]?.trim()) info.label = w[3].trim();
          scan.wikilinks.push(info);
        }
        i += w[0].length;
        continue;
      }
    }
    const isImage = ch === '!' && t[i + 1] === '[';
    if (ch === '[' || isImage) {
      const open = isImage ? i + 1 : i;
      if (!isImage && t[open + 1] === '^') {
        i++;
        continue;
      }
      const close = matchBracket(t, open);
      if (close > 0 && close < to) {
        const inner = t.slice(open + 1, close);
        let target: { url: string; title?: string; end: number } | null = null;
        if (t[close + 1] === '(') target = parseDestination(t, close + 2);
        else if (t[close + 1] === '[') {
          const rc = t.indexOf(']', close + 2);
          if (rc > 0) {
            const label = normalizeLabel(t.slice(close + 2, rc) || inner);
            const def = defs.get(label);
            if (def) target = { ...def, end: rc + 1 };
          }
        } else {
          const def = defs.get(normalizeLabel(inner));
          if (def) target = { ...def, end: close + 1 };
        }
        if (target && (!inLink || isImage)) {
          const p = pos(i);
          if (isImage) {
            const img: PageScan['images'][number] = { src: target.url, alt: plainInline(inner), ...p, standalone: false };
            if (target.title) img.title = target.title;
            scan.images.push(img);
          } else {
            const { rel, explicit } = parseRel(target.title);
            const link: PageScan['links'][number] = {
              href: target.url,
              text: plainInline(inner).trim(),
              rel,
              relExplicit: explicit,
              ...p,
              external: isExternal(target.url),
            };
            if (target.title) link.title = target.title;
            scan.links.push(link);
            scanInline(t, open + 1, close, true, scan, defs, pos);
          }
          i = target.end;
          continue;
        }
      }
      i = open + 1;
      continue;
    }
    i++;
  }
}
