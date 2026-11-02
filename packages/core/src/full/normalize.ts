/**
 * Normalizer: CFM -> standard markdown (gfm or commonmark profile) with a loss ledger.
 * Works by source edits in stages (leaf constructs, then callouts/toggles, then drawers), reparsing
 * between stages, so untouched markdown is byte-identical and output is idempotent.
 */
import type { Blockquote, Html, Image, Link, Root } from 'mdast';
import { visitParents } from 'unist-util-visit-parents';
import { parseMdast, blockquoteCallout, calloutLead, stripQuotePrefix } from './parse.ts';
import { applyEdits, autofix, type Edit } from '../autofix.ts';
import { splitFrontmatter, parseFrontmatter } from '../frontmatter.ts';
import { locateInlineLink } from '../light/scan.ts';
import { isExternal, relativePath, resolvePath, splitHash } from '../paths.ts';
import { encodeHref } from '../resolve.ts';
import {
  CALLOUT_TYPES,
  calloutLabel,
  findTags,
  NATIVE_CALLOUTS,
  parseCalloutMarker,
  parseImageFragment,
  parseTableDirective,
  splitImageSrc,
} from '../syntax.ts';
import type { FrontmatterValue, LedgerEntry, VaultContext } from '../types.ts';

export type Profile = 'gfm' | 'commonmark';

export interface NormalizeOptions {
  /** Page path (root-relative). Required for page-relative link rewriting. */
  path?: string;
  frontmatter?: 'keep' | 'strip' | 'inline';
  keepImageSize?: boolean;
  captions?: 'title' | 'visible';
  /** Map of root-relative image paths to new root-relative paths (used by export). */
  imageMap?: Map<string, string>;
}

export interface NormalizeResult {
  src: string;
  ledger: LedgerEntry[];
}

const EXTENDED_TO_GFM: Record<string, string | null> = {
  info: 'NOTE',
  question: 'NOTE',
  example: 'NOTE',
  assumption: 'NOTE',
  success: 'TIP',
  decision: 'IMPORTANT',
  danger: 'CAUTION',
  quote: null,
};

/** Container prefix for continuation lines, derived from the line holding `offset`. */
function prefixAt(src: string, offset: number): string {
  const ls = src.lastIndexOf('\n', offset - 1) + 1;
  const before = src.slice(ls, offset);
  const m = /^(?:\s*(?:[-+*]|\d{1,9}[.)])\s+|\s{0,3}>\s?|\s+)*/.exec(before);
  const p = m ? m[0] : '';
  return p.replace(/[-+*]|\d{1,9}[.)]/g, (x) => ' '.repeat(x.length));
}

function lineStartOf(src: string, offset: number): number {
  return src.lastIndexOf('\n', offset - 1) + 1;
}

function lineEndOf(src: string, offset: number): number {
  const e = src.indexOf('\n', offset);
  return e < 0 ? src.length : e;
}

function escapeHtml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function lineOf(src: string, offset: number): number {
  let n = 1;
  for (let i = 0; i < offset && i < src.length; i++) if (src[i] === '\n') n++;
  return n;
}

// ---------------- frontmatter ----------------

function fmLabel(key: string): string {
  return key.charAt(0).toUpperCase() + key.slice(1).replace(/[-_]/g, ' ');
}

function fmValue(v: FrontmatterValue): string {
  if (Array.isArray(v)) return v.join(', ');
  return String(v);
}

/** Inline frontmatter: title -> H1 if absent, remaining useful fields -> a short list. */
export function inlineFrontmatter(src: string, ledger: LedgerEntry[] = []): string {
  const { raw, body } = splitFrontmatter(src);
  if (!raw) return src;
  const fm = parseFrontmatter(src);
  const skip = new Set(['title', 'locked', 'order', 'pinned', 'icon']);
  const items = Object.entries(fm.data).filter(([k, v]) => !skip.has(k) && v !== null && !(Array.isArray(v) && v.length === 0));
  const listMd = items.map(([k, v]) => `- **${fmLabel(k)}:** ${fmValue(v!)}`).join('\n');
  for (const k of ['locked', 'order', 'pinned', 'icon']) if (k in fm.data) ledger.push({ construct: 'frontmatter', action: `dropped ${k}`, line: 1, lost: `${k} UI behavior` });
  let rest = body.replace(/^\n+/, '');
  const h1 = /^# .*(\n|$)/.exec(rest);
  const title = typeof fm.data.title === 'string' || typeof fm.data.title === 'number' ? String(fm.data.title) : null;
  let head = '';
  if (h1) {
    head = h1[0].replace(/\n$/, '');
    rest = rest.slice(h1[0].length).replace(/^\n+/, '');
  } else if (title) {
    head = `# ${title}`;
    ledger.push({ construct: 'frontmatter', action: 'title became H1', line: 1 });
  }
  const parts = [head, listMd, rest].filter((x) => x !== '');
  if (listMd) ledger.push({ construct: 'frontmatter', action: `${items.length} field(s) became a metadata list`, line: 1 });
  return parts.join('\n\n');
}

// ---------------- stage 1: leaves ----------------

function stageLeaves(src: string, profile: Profile, opts: NormalizeOptions, ctx: VaultContext | null, ledger: LedgerEntry[]): string {
  const tree = parseMdast(src);
  const edits: Edit[] = [];
  const path = opts.path ?? 'index.md';
  const assetsDir = ctx?.config.assets_dir ?? 'images';

  const rewriteTarget = (href: string, isImage: boolean): string | null => {
    if (isExternal(href)) return null;
    const { path: p, hash } = splitHash(href);
    if (p === '') return null;
    const resolved = resolvePath(p, path);
    if (resolved === null) return null;
    let target = resolved;
    if (isImage && opts.imageMap?.has(resolved)) target = opts.imageMap.get(resolved)!;
    if (!p.startsWith('/') && target === resolved) return null;
    const rel = relativePath(path, target);
    return encodeHref(rel) + (hash !== undefined && !isImage ? `#${hash}` : '');
  };

  visitParents(tree, (node, ancestors) => {
    if (!node.position) return;
    const start = node.position.start.offset!;
    const end = node.position.end.offset!;
    if (node.type === 'link') {
      const loc = locateInlineLink(src, start);
      if (!loc) return;
      const raw = src.slice(loc.urlStart, loc.urlEnd);
      const next = rewriteTarget(raw, false);
      if (next !== null && next !== raw) {
        edits.push({ start: loc.urlStart, end: loc.urlEnd, text: next });
      }
      if (!isExternal((node as Link).url) && ctx) {
        const r = resolvePath(splitHash((node as Link).url).path || path, path);
        if (r && r.endsWith('.md') && !ctx.pages.some((pg) => pg.path === r))
          ledger.push({ construct: 'link', action: `broken link to /${r} kept`, line: node.position.start.line });
      }
      return;
    }
    if (node.type === 'image') {
      const img = node as Image;
      const loc = locateInlineLink(src, start);
      if (!loc) return;
      const raw = src.slice(loc.urlStart, loc.urlEnd);
      const { path: p, fragment } = splitImageSrc(raw);
      const meta = parseImageFragment(fragment).meta;
      const parent = ancestors[ancestors.length - 1];
      const standalone = parent?.type === 'paragraph' && parent.children.filter((c) => !(c.type === 'text' && !c.value.trim())).length === 1;
      let newPath = rewriteTarget(p, true) ?? p;
      if (opts.keepImageSize && profile === 'gfm' && meta.w && !meta.w.endsWith('%')) {
        const html = `<img src="${escapeHtml(newPath)}" alt="${escapeHtml(img.alt ?? '')}" width="${meta.w}"${img.title ? ` title="${escapeHtml(img.title)}"` : ''}>`;
        edits.push({ start, end, text: html });
        ledger.push({ construct: 'image', action: 'kept width as <img>', line: node.position.start.line, lost: 'align, wrap, zoom, border' });
        return;
      }
      if (fragment !== null || newPath !== p) {
        if (newPath.includes(' ') && !loc.angle) newPath = encodeHref(newPath);
        edits.push({ start: loc.urlStart, end: loc.urlEnd, text: newPath });
        if (fragment) ledger.push({ construct: 'image', action: 'display attributes dropped', line: node.position.start.line, lost: fragment.split('&').map((x) => x.split('=')[0]).join(', ') });
      }
      if (opts.captions === 'visible' && standalone && img.title && parent?.position) {
        const pEnd = parent.position.end.offset!;
        const prefix = prefixAt(src, pEnd);
        edits.push({ start: pEnd, end: pEnd, text: `\n${prefix.trimEnd()}\n${prefix}*${img.title.replace(/\*/g, '\\*')}*` });
      }
      void assetsDir;
      return;
    }
    if (node.type === 'html') {
      const h = node as Html;
      const attrs = parseTableDirective(h.value);
      if (attrs) {
        const ls = lineStartOf(src, start);
        const le = lineEndOf(src, end);
        const prefix = prefixAt(src, start);
        const caption = attrs.caption;
        const text = caption ? `${prefix}*${caption.replace(/\*/g, '\\*')}*\n${prefix.trimEnd()}` : null;
        if (text) edits.push({ start: ls, end: le, text });
        else edits.push({ start: ls, end: Math.min(le + 1, src.length), text: '' });
        const lost = Object.keys(attrs).filter((k) => k !== 'caption');
        ledger.push({ construct: 'table', action: caption ? 'directive removed, caption kept above' : 'directive removed', line: node.position.start.line, ...(lost.length ? { lost: lost.join(', ') } : {}) });
        return;
      }
      if (profile === 'commonmark') {
        const isToggle = findTags(h.value).some((t) => t.tag === 'details' || t.tag === 'summary');
        if (isToggle) return; // stage 2
        const parent = ancestors[ancestors.length - 1];
        const isBlock = parent?.type === 'root' || parent?.type === 'blockquote' || parent?.type === 'listItem';
        if (/^<!--/.test(h.value.trim())) {
          if (isBlock) {
            edits.push({ start: lineStartOf(src, start), end: Math.min(lineEndOf(src, end) + 1, src.length), text: '' });
            ledger.push({ construct: 'html', action: 'comment removed', line: node.position.start.line });
          }
          return;
        }
        const tag = findTags(h.value)[0];
        if (!tag) return;
        let repl = '';
        if (tag.tag === 'kbd' && !tag.closing) {
          // Convert <kbd>X</kbd> to `X`: find matching close in the same parent.
          const sibs = (parent as { children: { type: string; value?: string; position?: { start: { offset?: number }; end: { offset?: number } } }[] }).children;
          const idx = sibs.indexOf(node as never);
          const close = sibs.findIndex((s, i) => i > idx && s.type === 'html' && /^<\/kbd>$/i.test(s.value ?? ''));
          if (close > idx) {
            const inner = sibs.slice(idx + 1, close).map((s) => (s.type === 'text' || s.type === 'inlineCode' ? s.value : '')).join('');
            const cs = sibs[close]!.position!.end.offset!;
            const tick = inner.includes('`') ? '``' : '`';
            edits.push({ start, end: cs, text: `${tick}${inner}${tick}` });
            ledger.push({ construct: 'html', action: '<kbd> became code', line: node.position.start.line });
            return;
          }
        }
        if (tag.tag === 'br') repl = ' ';
        edits.push({ start, end, text: repl });
        ledger.push({ construct: 'html', action: `<${tag.closing ? '/' : ''}${tag.tag}> removed`, line: node.position.start.line });
      }
    }
  });
  // Remove edits nested inside larger edits (kbd conversion).
  const filtered = edits.filter((e) => !edits.some((o) => o !== e && o.start <= e.start && o.end >= e.end && (o.start < e.start || o.end > e.end)));
  return applyEdits(src, filtered);
}

// ---------------- stage 2: callouts and toggles ----------------

function stageBlocks(src: string, profile: Profile, ledger: LedgerEntry[]): string {
  const tree = parseMdast(src);
  const edits: Edit[] = [];
  visitParents(tree, (node) => {
    if (node.type === 'blockquote') {
      const bq = node as Blockquote;
      if (!blockquoteCallout(bq)) return;
      const first = bq.children[0]!;
      const fStart = first.position!.start.offset!;
      const lineEnd = lineEndOf(src, fStart);
      const marker = parseCalloutMarker(stripQuotePrefix(src.slice(lineStartOf(src, fStart), lineEnd)).trim());
      if (!marker) return;
      const prefix = prefixAt(src, fStart);
      const bqEnd = bq.position!.end.offset!;
      const hasMore = lineEnd < bqEnd;
      const sep = hasMore ? `\n${prefix.trimEnd()}` : '';
      let label = calloutLabel(marker.type);
      let title = marker.title;
      const native = (NATIVE_CALLOUTS as readonly string[]).includes(marker.type);
      const lostFold = marker.fold ? 'fold marker, ' : '';
      const lead = calloutLead(bq, src.split('\n'));
      let replaceEnd = lineEnd;
      if (lead !== null) {
        // Already in normalized GFM form (`[!NOTE]` + bold lead line).
        if (profile === 'gfm') return;
        const lm = /^([A-Za-z]+)(?::\s*(.*))?$/.exec(lead);
        if (lm && CALLOUT_TYPES.includes(lm[1]!.toLowerCase())) {
          label = calloutLabel(lm[1]!);
          title = lm[2] ?? '';
        } else title = lead;
        replaceEnd = lineEndOf(src, lineEnd + 1);
      }
      const more = replaceEnd < bqEnd;
      const sep2 = more ? `\n${prefix.trimEnd()}` : '';
      // Body whose first line is bold-only must not be glued to a bare marker (it would read as a title).
      const firstBody = lead === null ? src.slice(lineEnd + 1, lineEndOf(src, lineEnd + 1)) : '';
      const bodyLooksLikeLead = lead === null && !title && hasMore && /^(\*\*|__)\S[\s\S]*\1$/.test(stripQuotePrefix(firstBody).trim()) && first.position!.end.offset! > lineEnd;
      let text: string;
      if (profile === 'gfm') {
        if (native) {
          text = `[!${marker.type.toUpperCase()}]${title ? `\n${prefix}**${title}**${sep}` : bodyLooksLikeLead ? sep : ''}`;
          if (!marker.fold && !title && !bodyLooksLikeLead && /^\[![A-Z]+\]$/.test(src.slice(fStart, lineEnd).trim())) return;
        } else {
          const gfmType = EXTENDED_TO_GFM[marker.type] ?? null;
          const leadLine = `**${label}${title ? `: ${title}` : ''}**`;
          text = gfmType ? `[!${gfmType}]\n${prefix}${leadLine}${sep}` : `${leadLine}${sep}`;
        }
      } else {
        text = `**${label}${title ? `: ${title}` : ''}**${sep2}`;
      }
      edits.push({ start: fStart, end: replaceEnd, text });
      ledger.push({
        construct: 'callout',
        action: profile === 'gfm' ? (native ? 'kept as GFM alert' : `mapped ${marker.type} to ${EXTENDED_TO_GFM[marker.type] ?? 'blockquote'}`) : 'blockquote with bold label',
        line: node.position!.start.line,
        lost: `${lostFold}color, icon`.replace(/^, /, ''),
      });
      return;
    }
    if (node.type === 'html' && profile === 'commonmark') {
      const h = node as Html;
      const tags = findTags(h.value);
      if (!tags.some((t) => t.tag === 'details' || t.tag === 'summary')) return;
      const start = node.position!.start.offset!;
      const end = node.position!.end.offset!;
      const prefix = prefixAt(src, start);
      let v = h.value;
      v = v.replace(/<summary[^>]*>([\s\S]*?)<\/summary>/gi, (_m, t: string) => `\n\n**${t.replace(/<[^>]+>/g, '').trim()}**\n\n`);
      v = v.replace(/<\/?details[^>]*>/gi, '\n');
      const parts = v.split(/\n{2,}/).map((x) => x.split('\n').map((l) => l.trim()).filter(Boolean).join('\n')).filter(Boolean);
      const text = parts.map((p) => p.split('\n').join(`\n${prefix}`)).join(`\n${prefix.trimEnd()}\n${prefix}`);
      if (text === '') {
        edits.push({ start: lineStartOf(src, start), end: Math.min(lineEndOf(src, end) + 1, src.length), text: '' });
      } else edits.push({ start, end, text });
      if (/<summary/i.test(h.value)) ledger.push({ construct: 'toggle', action: 'became a bold title paragraph', line: node.position!.start.line, lost: 'collapsibility' });
    }
  });
  return applyEdits(src, edits);
}

// ---------------- stage 3: drawers ----------------

const CLOSE_FENCE_RE = /^\s{0,3}:{3,}\s*$/;

function stageDrawers(src: string, profile: Profile, ledger: LedgerEntry[]): string {
  const tree = parseMdast(src);
  const edits: Edit[] = [];
  visitParents(tree, 'containerDirective', (node) => {
    if (node.name !== 'drawer' || !node.position) return;
    const start = node.position.start.offset!;
    const end = node.position.end.offset!;
    const prefix = prefixAt(src, start);
    const bare = prefix.trimEnd();
    const title = (node.attributes?.title ?? '').trim() || 'Details';
    const openStart = start;
    const openEnd = lineEndOf(src, start);
    const lastLineStart = lineStartOf(src, end);
    const lastLine = src.slice(lastLineStart, lineEndOf(src, lastLineStart));
    const closed = lastLineStart > openStart && CLOSE_FENCE_RE.test(stripQuotePrefix(lastLine));
    const bodyFirst = openEnd + 1;
    const bodyEndLine = closed ? lastLineStart : lineEndOf(src, end) + 1;
    if (profile === 'gfm') {
      edits.push({ start: openStart, end: openEnd, text: `<details>\n${prefix}<summary>${escapeHtml(title)}</summary>\n${bare}` });
      if (closed) edits.push({ start: lastLineStart, end: lineEndOf(src, lastLineStart), text: `${bare}\n${prefix}</details>` });
      else edits.push({ start: end, end, text: `\n${bare}\n${prefix}</details>` });
      ledger.push({ construct: 'drawer', action: 'converted to collapsed <details>', line: node.position.start.line, lost: 'side-panel behavior, icon, width' });
    } else {
      edits.push({ start: openStart, end: openEnd, text: `> **${title}**\n${bare}${bare ? ' ' : ''}>` });
      for (let ls = bodyFirst; ls < bodyEndLine && ls <= src.length; ) {
        const le = lineEndOf(src, ls);
        const pAt = ls + prefix.length;
        const content = src.slice(pAt, le);
        if (ls < src.length) edits.push({ start: pAt, end: pAt, text: content.trim() === '' ? '>' : '> ' });
        ls = le + 1;
      }
      if (closed) edits.push({ start: lastLineStart, end: Math.min(lineEndOf(src, lastLineStart) + 1, src.length), text: '' });
      ledger.push({ construct: 'drawer', action: 'converted to a titled blockquote', line: node.position.start.line, lost: 'side-panel behavior, icon, width' });
    }
  });
  return applyEdits(src, edits);
}

/** Normalize CFM to standard markdown. */
export function normalize(src: string, profile: Profile = 'gfm', ctx: VaultContext | null = null, opts: NormalizeOptions = {}): NormalizeResult {
  const ledger: LedgerEntry[] = [];
  let out = autofix(src, ctx, opts.path ? { path: opts.path } : {}).src;
  for (const w of [...out.matchAll(/\[\[[^\]\n]*\]\]/g)]) ledger.push({ construct: 'wikilink', action: `unresolved ${w[0]} kept as text`, line: lineOf(out, w.index) });
  const fmMode = opts.frontmatter ?? (profile === 'gfm' ? 'keep' : 'inline');
  if (fmMode === 'strip') {
    const { raw, body } = splitFrontmatter(out);
    if (raw) {
      out = body.replace(/^\n+/, '');
      ledger.push({ construct: 'frontmatter', action: 'stripped', line: 1, lost: 'all metadata' });
    }
  } else if (fmMode === 'inline') out = inlineFrontmatter(out, ledger);
  out = stageLeaves(out, profile, opts, ctx, ledger);
  out = stageBlocks(out, profile, ledger);
  out = stageDrawers(out, profile, ledger);
  out = out.replace(/\n*$/, '\n');
  return { src: out, ledger };
}

export function summarizeLedger(ledger: LedgerEntry[]): string {
  const counts = new Map<string, number>();
  for (const e of ledger) counts.set(`${e.construct}: ${e.action}`, (counts.get(`${e.construct}: ${e.action}`) ?? 0) + 1);
  return [...counts.entries()].map(([k, n]) => `${n} × ${k}`).join('\n');
}

export type { Root };
