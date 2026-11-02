/**
 * Semantic fingerprint: the content that must survive normalization, in document order.
 * See SPEC 7.4. Callouts, toggles and drawers project to a titled paragraph item
 * (`p:Label: Title`), which is the documented mapping the normalizer applies.
 */
import type { Nodes, Root, RootContent, Blockquote, Table } from 'mdast';
import { calloutLead, parseMdast, stripQuotePrefix } from './parse.ts';
import { inlineFrontmatter } from './normalize.ts';
import { calloutLabel, findTags, parseCalloutMarker, parseRel, parseTableDirective, splitImageSrc, CALLOUT_TYPES } from '../syntax.ts';
import { isExternal, resolvePath, splitHash } from '../paths.ts';
import { plainInline } from '../light/scan.ts';

export type Fingerprint = string[];

export interface FingerprintOptions {
  path?: string;
  /** Apply the frontmatter inline mapping before fingerprinting (commonmark default). */
  inlineFrontmatter?: boolean;
}

function ws(s: string): string {
  return s.replace(/\s+/g, ' ').trim();
}

function textOf(node: Nodes): string {
  switch (node.type) {
    case 'text':
    case 'inlineCode':
      return node.value;
    case 'image':
      return node.alt ?? '';
    case 'break':
      return ' ';
    case 'html':
      return /^<br\s*\/?>$/i.test(node.value.trim()) ? ' ' : '';
    case 'footnoteReference':
      return '';
    default:
      return 'children' in node ? (node.children as Nodes[]).map(textOf).join('') : '';
  }
}

export function semanticFingerprint(src: string, opts: FingerprintOptions = {}): Fingerprint {
  const input = opts.inlineFrontmatter ? inlineFrontmatter(src) : src;
  const tree = parseMdast(input);
  const path = opts.path ?? 'index.md';
  const defs = new Map<string, { url: string; title: string | null | undefined }>();
  const collect = (n: Nodes) => {
    if (n.type === 'definition') defs.set(n.identifier, { url: n.url, title: n.title });
    if ('children' in n) (n.children as Nodes[]).forEach(collect);
  };
  collect(tree);
  const items: string[] = [];
  const lines = input.split('\n');

  const target = (url: string): string => {
    if (isExternal(url)) return url;
    const { path: p, hash } = splitHash(url);
    const r = p === '' ? path : (resolvePath(splitImageSrc(p).path, path) ?? p);
    return hash !== undefined && !/\.(png|jpe?g|gif|webp|svg)$/i.test(r) ? `${r}#${hash}` : r;
  };

  const inlines = (n: Nodes) => {
    if (n.type === 'link' || n.type === 'linkReference') {
      const d = n.type === 'link' ? { url: n.url, title: n.title } : defs.get(n.identifier);
      if (d) items.push(`link:${ws(textOf(n))}|${target(d.url)}|${parseRel(d.title).rel}`);
    }
    if (n.type === 'image' || n.type === 'imageReference') {
      const d = n.type === 'image' ? { url: n.url, title: n.title } : defs.get(n.identifier);
      if (d) items.push(`img:${ws(n.alt ?? '')}|${target(splitImageSrc(d.url).path)}|${d.title ?? ''}`);
    }
    if ('children' in n) (n.children as Nodes[]).forEach(inlines);
  };

  const paragraph = (n: Nodes, text?: string) => {
    const t = ws(text ?? textOf(n));
    if (t) items.push(`p:${t}`);
    inlines(n);
  };

  const calloutOf = (bq: Blockquote): { label: string; titleFromLead: boolean } | null => {
    const first = bq.children[0];
    if (!first || first.type !== 'paragraph' || !first.position) return null;
    const line = stripQuotePrefix(lines[first.position.start.line - 1] ?? '').trim();
    const m = parseCalloutMarker(line);
    if (!m) return null;
    let label = calloutLabel(m.type);
    let title = plainInline(m.title).trim();
    let titleFromLead = false;
    const lead = title ? null : calloutLead(bq, lines);
    if (lead !== null) {
      const lm = /^([A-Za-z]+)(?::\s*(.*))?$/.exec(lead);
      if (lm && CALLOUT_TYPES.includes(lm[1]!.toLowerCase())) {
        label = calloutLabel(lm[1]!);
        title = lm[2] ?? '';
      } else title = lead;
      titleFromLead = true;
    }
    items.push(`p:${ws(title ? `${label}: ${title}` : label)}`);
    return { label, titleFromLead };
  };

  const walk = (nodes: RootContent[]) => {
    for (let i = 0; i < nodes.length; i++) {
      const n = nodes[i]!;
      switch (n.type) {
        case 'yaml':
        case 'definition':
          break;
        case 'heading':
          items.push(`h${n.depth}:${ws(textOf(n))}`);
          inlines(n);
          break;
        case 'paragraph':
          paragraph(n);
          break;
        case 'thematicBreak':
          items.push('hr');
          break;
        case 'blockquote': {
          const c = calloutOf(n);
          if (c) {
            const [first, ...rest] = n.children;
            if (first && first.type === 'paragraph' && !c.titleFromLead) {
              // Body text after the marker line in the first paragraph.
              const head = first.children[0];
              const clone = { ...first, children: [...first.children] };
              if (head && head.type === 'text') {
                const after = head.value.split('\n').slice(1).join('\n');
                clone.children[0] = { ...head, value: after };
              }
              paragraph(clone);
            }
            walk(rest);
          } else walk(n.children);
          break;
        }
        case 'list':
          for (const li of n.children) {
            items.push(`li:${n.ordered ? 'o' : 'u'}:${li.checked === true ? 'x' : li.checked === false ? ' ' : '-'}`);
            walk(li.children);
          }
          break;
        case 'table': {
          const prev = nodes[i - 1];
          if (prev && prev.type === 'html') {
            const attrs = parseTableDirective(prev.value);
            if (attrs?.caption) items.push(`p:${ws(attrs.caption)}`);
          }
          const t = n as Table;
          items.push(`table:${(t.align ?? []).map((a) => a ?? '-').join(',')}`);
          for (const row of t.children) {
            items.push(`tr:${row.children.map((c) => ws(textOf(c))).join(' | ')}`);
            row.children.forEach(inlines);
          }
          break;
        }
        case 'code':
          items.push(`code:${n.lang ?? ''}:${n.value}`);
          break;
        case 'html':
          for (const t of findTags(n.value)) void t;
          for (const m of n.value.matchAll(/<summary[^>]*>([\s\S]*?)<\/summary>/gi)) items.push(`p:${ws(m[1]!.replace(/<[^>]+>/g, ''))}`);
          break;
        case 'containerDirective':
          if (n.name === 'drawer') {
            const title = (n.attributes?.title ?? '').trim() || 'Details';
            items.push(`p:${ws(title)}`);
          }
          walk(n.children as RootContent[]);
          break;
        case 'footnoteDefinition':
          items.push('fn');
          walk(n.children);
          break;
        default:
          if ('children' in n) walk((n as { children: RootContent[] }).children);
      }
    }
  };
  walk((tree as Root).children);
  return items;
}
