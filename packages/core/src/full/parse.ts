import { unified } from 'unified';
import remarkParse from 'remark-parse';
import remarkGfm from 'remark-gfm';
import remarkFrontmatter from 'remark-frontmatter';
import remarkDirective from 'remark-directive';
import type { Root, Nodes, Parents, RootContent, Html, Blockquote, Paragraph, Text } from 'mdast';
import { visitParents } from 'unist-util-visit-parents';
import { parseFrontmatter } from '../frontmatter.ts';
import { createSlugger } from '../slug.ts';
import {
  findTags,
  parseCalloutMarker,
  parseRel,
  parseTableDirective,
  scanToggleLayout,
  WIKILINK_RE,
} from '../syntax.ts';
import { isExternal } from '../paths.ts';
import type { DrawerInfo, PageScan } from '../types.ts';

export interface PageAst {
  src: string;
  tree: Root;
  scan: PageScan;
}

const processor = unified().use(remarkParse).use(remarkGfm).use(remarkFrontmatter, ['yaml']).use(remarkDirective);

/** Parse markdown to mdast with Nitrogen post-processing (no CFM node rewriting). */
export function parseMdast(src: string): Root {
  const tree = processor.parse(src) as Root;
  restoreDirectiveText(tree, src);
  return tree;
}

/** Only container `drawer` directives are CFM; text and leaf directives go back to plain text. */
function restoreDirectiveText(tree: Root, src: string): void {
  const walk = (node: Parents) => {
    const kids = node.children as RootContent[];
    for (let i = 0; i < kids.length; i++) {
      const k = kids[i]!;
      if ((k.type === 'textDirective' || k.type === 'leafDirective') && k.position) {
        const value = src.slice(k.position.start.offset, k.position.end.offset);
        const replacement =
          k.type === 'leafDirective'
            ? ({ type: 'paragraph', children: [{ type: 'text', value, position: k.position }], position: k.position } as Paragraph)
            : ({ type: 'text', value, position: k.position } as Text);
        kids[i] = replacement as RootContent;
      } else if ('children' in k) walk(k as Parents);
    }
    // Merge adjacent text nodes created above.
    for (let i = kids.length - 1; i > 0; i--) {
      const a = kids[i - 1]!;
      const b = kids[i]!;
      if (a.type === 'text' && b.type === 'text') {
        a.value += b.value;
        if (a.position && b.position) a.position.end = b.position.end;
        kids.splice(i, 1);
      }
    }
  };
  walk(tree);
}

/** Plain text of a node: text, inline code and image alt; HTML is skipped. */
export function nodeText(node: Nodes): string {
  if (node.type === 'text' || node.type === 'inlineCode') return node.value;
  if (node.type === 'image') return node.alt ?? '';
  if (node.type === 'break') return ' ';
  if (node.type === 'html') return '';
  if ('children' in node) return (node.children as Nodes[]).map(nodeText).join('');
  return '';
}

/** The callout marker of a blockquote, or null. */
export function blockquoteCallout(bq: Blockquote): ReturnType<typeof parseCalloutMarker> {
  const first = bq.children[0];
  if (!first || first.type !== 'paragraph') return null;
  const t = first.children[0];
  if (!t || t.type !== 'text') return null;
  const firstLine = t.value.split('\n')[0]!;
  // Title may contain inline markup after the marker; use the source text of the first line.
  return parseCalloutMarker(firstLine);
}

/**
 * The "lead title" convention of normalized GFM output: an uppercase native alert marker alone on
 * its line, directly followed (same paragraph) by a strong-only line, e.g. `> [!NOTE]\n> **Title**`.
 * Returns the plain lead text, or null.
 */
export function calloutLead(bq: Blockquote, lines: string[]): string | null {
  const first = bq.children[0];
  if (!first || first.type !== 'paragraph' || !first.position) return null;
  const markerLine = stripQuotePrefix(lines[first.position.start.line - 1] ?? '').trim();
  if (!/^\[!(NOTE|TIP|IMPORTANT|WARNING|CAUTION)\]$/.test(markerLine)) return null;
  const head = first.children[0];
  if (!head || head.type !== 'text') return null;
  const afterMarker = head.value.split('\n').slice(1).join('\n').trim();
  if (afterMarker) return null;
  const rest = first.children.slice(1).filter((c) => !(c.type === 'text' && c.value.trim() === ''));
  if (rest.length !== 1 || rest[0]!.type !== 'strong') return null;
  return nodeText(rest[0]!).replace(/\s+/g, ' ').trim();
}

/** Group sibling html nodes into toggle depth per child index. */
function toggleDepths(children: RootContent[]): number[] {
  const depths: number[] = [];
  let d = 0;
  for (const c of children) {
    depths.push(d);
    if (c.type === 'html') {
      for (const t of findTags(c.value)) {
        if (t.tag === 'details') d += t.closing ? -1 : 1;
      }
      if (d < 0) d = 0;
    }
  }
  return depths;
}

export function parsePage(src: string): PageAst {
  const tree = parseMdast(src);
  return { src, tree, scan: scanTree(tree, src) };
}

export function scanTree(tree: Root, src: string): PageScan {
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
  const slugger = createSlugger();
  const defs = new Map<string, { url: string; title: string | null | undefined }>();
  visitParents(tree, 'definition', (d) => {
    if (!defs.has(d.identifier)) defs.set(d.identifier, { url: d.url, title: d.title });
  });
  const lines = src.split('\n');

  visitParents(tree, (node, ancestors) => {
    const pos = node.position?.start;
    const line = pos?.line ?? 0;
    const col = pos?.column ?? 0;
    switch (node.type) {
      case 'heading': {
        const text = nodeText(node).trim();
        scan.headings.push({ level: node.depth, text, slug: slugger.slug(text), line });
        break;
      }
      case 'link':
      case 'linkReference': {
        let url: string;
        let title: string | null | undefined;
        if (node.type === 'link') {
          url = node.url;
          title = node.title;
        } else {
          const def = defs.get(node.identifier);
          if (!def) break;
          url = def.url;
          title = def.title;
        }
        // GFM autolink literals and <autolinks> are external by construction.
        const { rel, explicit } = parseRel(title);
        const info = {
          href: url,
          text: nodeText(node).trim(),
          rel,
          relExplicit: explicit,
          line,
          col,
          external: isExternal(url),
          ...(title ? { title } : {}),
        };
        scan.links.push(info);
        break;
      }
      case 'image':
      case 'imageReference': {
        let url: string;
        let title: string | null | undefined;
        if (node.type === 'image') {
          url = node.url;
          title = node.title;
        } else {
          const def = defs.get(node.identifier);
          if (!def) break;
          url = def.url;
          title = def.title;
        }
        const parent = ancestors[ancestors.length - 1];
        const standalone =
          parent?.type === 'paragraph' &&
          parent.children.filter((c) => !(c.type === 'text' && c.value.trim() === '')).length === 1;
        scan.images.push({ src: url, alt: node.alt ?? '', line, col, standalone, ...(title ? { title } : {}) });
        break;
      }
      case 'text': {
        if (ancestors.some((a) => a.type === 'link' || a.type === 'linkReference')) break;
        WIKILINK_RE.lastIndex = 0;
        let m: RegExpExecArray | null;
        while ((m = WIKILINK_RE.exec(node.value))) {
          const before = node.value.slice(0, m.index);
          const nl = before.split('\n');
          const wl = line + nl.length - 1;
          // Column of a wikilink on a continuation line: derive from source line.
          let wc: number;
          if (nl.length === 1) wc = col + m.index;
          else {
            const srcLine = lines[wl - 1] ?? '';
            const seg = node.value.split('\n')[nl.length - 1] ?? '';
            const segAt = srcLine.lastIndexOf(seg);
            wc = (segAt < 0 ? 0 : segAt) + nl[nl.length - 1]!.length + 1;
          }
          const w = { raw: m[0], target: (m[1] ?? '').trim(), line: wl, col: wc } as PageScan['wikilinks'][number];
          if (m[2]?.trim()) w.anchor = m[2].trim();
          if (m[3]?.trim()) w.label = m[3].trim();
          if (w.target || w.anchor) scan.wikilinks.push(w);
        }
        break;
      }
      case 'blockquote': {
        if (!blockquoteCallout(node)) break;
        const first = node.children[0]!;
        const fl = first.position?.start.line ?? line;
        const c = parseCalloutMarker(stripQuotePrefix(lines[fl - 1] ?? '').trim());
        if (c) scan.callouts.push({ ...c, line });
        break;
      }
      case 'containerDirective': {
        if (node.name !== 'drawer') break;
        const attrs: Record<string, string> = {};
        for (const [k, v] of Object.entries(node.attributes ?? {})) if (v !== null && v !== undefined) attrs[k] = v;
        scan.drawers.push({ attrs, line, parent: drawerParent(node, ancestors) });
        break;
      }
      case 'html': {
        for (const t of findTags(node.value)) {
          const before = node.value.slice(0, t.index);
          const nl = before.split('\n');
          const tl = line + nl.length - 1;
          const tc = nl.length === 1 ? col + t.index : nl[nl.length - 1]!.length + 1 + containerIndent(lines[tl - 1] ?? '');
          scan.html.push({ tag: t.tag, closing: t.closing, line: tl, col: tc, attrs: t.attrs });
        }
        const attrs = parseTableDirective(node.value);
        if (attrs) {
          const parent = ancestors[ancestors.length - 1] as Parents;
          const idx = (parent.children as RootContent[]).indexOf(node as RootContent);
          const next = (parent.children as RootContent[])[idx + 1];
          const endLine = node.position?.end.line ?? line;
          const columns =
            next && next.type === 'table' && next.position?.start.line === endLine + 1
              ? (next.children[0]?.children.length ?? 0)
              : null;
          scan.tableDirectives.push({ attrs, line, columns });
        }
        break;
      }
    }
  });
  // Code lines (fenced/indented) so the toggle scanner skips them.
  const codeLines = new Set<number>();
  visitParents(tree, 'code', (c) => {
    if (c.position) for (let l = c.position.start.line; l <= c.position.end.line; l++) codeLines.add(l - 1);
  });
  scan.toggles = scanToggleLayout(lines, (i) => codeLines.has(i), stripQuotePrefix).map((t) => ({
    line: t.line,
    missingBlankLines: t.missing,
    summary: t.summary,
  }));
  scan.links.sort(byPos);
  scan.images.sort(byPos);
  scan.html.sort(byPos);
  return scan;
}

function byPos(a: { line: number; col: number }, b: { line: number; col: number }): number {
  return a.line - b.line || a.col - b.col;
}

/** Strip blockquote `>` prefixes from a line. */
export function stripQuotePrefix(l: string): string {
  return l.replace(/^(?:\s{0,3}>\s?)+/, '');
}

function containerIndent(l: string): number {
  return l.length - stripQuotePrefix(l).length;
}

function drawerParent(node: Nodes, ancestors: Parents[]): DrawerInfo['parent'] {
  const parent = ancestors[ancestors.length - 1];
  if (!parent) return 'root';
  if (ancestors.slice(0, -1).some((a) => a.type === 'containerDirective' && a.name === 'drawer') ||
      (parent.type === 'containerDirective' && parent.name === 'drawer')) return 'drawer';
  if (ancestors.some((a) => a.type === 'listItem' || a.type === 'list')) return 'list';
  if (ancestors.some((a) => a.type === 'table' || a.type === 'footnoteDefinition')) return 'other';
  if (parent.type === 'blockquote') return blockquoteCallout(parent) ? 'callout' : 'blockquote';
  if (parent.type === 'root') {
    const idx = parent.children.indexOf(node as RootContent);
    return (toggleDepths(parent.children)[idx] ?? 0) > 0 ? 'toggle' : 'root';
  }
  return 'other';
}

export type { Html };
