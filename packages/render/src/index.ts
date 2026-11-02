/**
 * CFM -> HAST. mdast transforms turn CFM constructs into elements with `data-*` properties, then
 * mdast-util-to-hast, hast-util-raw (for <details>), a strict sanitizer, and heading slugs. The
 * result is framework-neutral: the web app maps elements to React components, the CLI to HTML.
 */
import type { Blockquote, Code, Html, Image, Link, Nodes, Paragraph, Parents, Root, RootContent, Table, Text } from 'mdast';
import type { Element, Root as HRoot, ElementContent } from 'hast';
import { toHast } from 'mdast-util-to-hast';
import { sanitize, defaultSchema, type Schema } from 'hast-util-sanitize';
import { toHtml } from 'hast-util-to-html';
import { visit } from 'unist-util-visit';
import {
  parseMdast,
  calloutLabel,
  parseCalloutMarker,
  parseImageFragment,
  parseRel,
  parseTableDirective,
  resolveLink,
  resolveWikilink,
  splitImageSrc,
  stripQuote,
  createSlugger,
  isExternal,
  WIKILINK_RE,
  CALLOUT_TYPES,
  frontmatterOf,
  findTags,
  type VaultContext,
} from './deps.ts';

export interface RenderOptions {
  /** Page path (root-relative) for link resolution. */
  path: string;
  ctx: VaultContext | null;
  /** Build an href for an internal page: default `/p/<path>`. */
  pageHref?: (path: string, anchor?: string) => string;
  /** Build a src for a repo asset: default `/api/blob?path=`. */
  assetSrc?: (path: string) => string;
}

function el(tagName: string, properties: Record<string, unknown>, children: ElementContent[] = []): Element {
  return { type: 'element', tagName, properties: properties as Element['properties'], children };
}

const defaultPageHref = (p: string, a?: string) => `/p/${p.split('/').map(encodeURIComponent).join('/')}${a ? `#${encodeURIComponent(a)}` : ''}`;
const defaultAssetSrc = (p: string) => `/api/blob?path=${encodeURIComponent(p)}`;

/** Remove the callout marker line from the first paragraph; returns the remaining children. */
function stripMarker(p: Paragraph): Paragraph['children'] {
  const kids = [...p.children];
  const head = kids[0];
  if (head && head.type === 'text') {
    const nl = head.value.indexOf('\n');
    if (nl < 0) kids.shift();
    else kids[0] = { ...head, value: head.value.slice(nl + 1) };
  }
  // Drop leading break/whitespace.
  while (kids[0] && kids[0].type === 'text' && kids[0].value.trim() === '') kids.shift();
  return kids;
}

/** mdast transforms for CFM. */
export function transformCfm(tree: Root, src: string, o: RenderOptions): void {
  const lines = src.split('\n');
  const pageHref = o.pageHref ?? defaultPageHref;
  const assetSrc = o.assetSrc ?? defaultAssetSrc;

  const imageProps = (img: Image) => {
    const { fragment } = splitImageSrc(img.url);
    const m = parseImageFragment(fragment).meta;
    return { dataAlign: m.align, dataW: m.w ?? '', dataH: m.h ?? '', dataWrap: String(m.wrap), dataZoom: String(m.zoom), dataBorder: String(m.border) };
  };

  const walk = (parent: Parents) => {
    const kids = parent.children as RootContent[];
    for (let i = 0; i < kids.length; i++) {
      const n = kids[i]!;
      // Table directives: attach to the next table and drop the comment.
      if (n.type === 'html') {
        const attrs = parseTableDirective(n.value);
        const next = kids[i + 1];
        if (attrs && next?.type === 'table') {
          (next as Table).data = { ...(next.data ?? {}), hProperties: { dataStyle: attrs.style ?? 'plain', dataHeader: attrs.header ?? 'normal', dataWidths: attrs.widths ?? '', dataDense: attrs.dense ?? 'false', dataWrap: attrs.wrap ?? 'true', dataCaption: attrs.caption ?? '' } } as never;
          kids.splice(i, 1);
          i--;
          continue;
        }
      }
      if (n.type === 'blockquote') {
        const first = (n as Blockquote).children[0];
        if (first?.type === 'paragraph' && first.position) {
          const m = parseCalloutMarker(stripQuote(lines[first.position.start.line - 1] ?? '').text.trim());
          if (m) {
            let type = m.type;
            let title = m.title;
            let body = stripMarker(first);
            // Normalized GFM lead-title convention: [!NOTE] + **Title** line.
            if (!title && /^[A-Z]+$/.test((/\[!([A-Za-z]+)\]/.exec(lines[first.position.start.line - 1] ?? '') ?? [])[1] ?? '') && body.length === 1 && body[0]!.type === 'strong') {
              const lead = (body[0].children as Nodes[]).map((c) => ('value' in c ? String(c.value) : '')).join('');
              const lm = /^([A-Za-z]+)(?::\s*(.*))?$/.exec(lead);
              if (lm && CALLOUT_TYPES.includes(lm[1]!.toLowerCase())) {
                type = lm[1]!.toLowerCase();
                title = lm[2] ?? '';
              } else title = lead;
              body = [];
            }
            const known = CALLOUT_TYPES.includes(type);
            const rest = [...(body.length ? [{ ...first, children: body } as Paragraph] : []), ...(n as Blockquote).children.slice(1)];
            (n as Blockquote).children = rest as Blockquote['children'];
            n.data = { hName: 'n2-callout', hProperties: { dataType: known ? type : 'note', dataUnknown: known ? undefined : type, dataFold: m.fold, dataTitle: title || calloutLabel(known ? type : 'note') } } as never;
          }
        }
      }
      if (n.type === 'containerDirective') {
        if (n.name === 'drawer') {
          const a = n.attributes ?? {};
          n.data = { hName: 'n2-drawer', hProperties: { dataTitle: a.title || 'Details', dataIcon: a.icon ?? '', dataWidth: a.width ?? 'md' } } as never;
        } else n.data = { hName: 'div', hProperties: { className: ['n2-container'] } } as never;
      }
      if (n.type === 'code' && (n as Code).lang === 'mermaid') {
        const c = n as Code;
        const meta = Object.fromEntries([...(c.meta ?? '').matchAll(/(\w+)="([^"]*)"/g)].map((m) => [m[1], m[2]]));
        kids[i] = { type: 'paragraph', children: [], data: { hName: 'n2-mermaid', hProperties: { dataSource: c.value, dataTitle: meta.title ?? '', dataCaption: meta.caption ?? '' } } } as never;
        continue;
      }
      if (n.type === 'paragraph') {
        const meaningful = n.children.filter((c) => !(c.type === 'text' && c.value.trim() === ''));
        if (meaningful.length === 1 && meaningful[0]!.type === 'image') {
          const img = meaningful[0] as Image;
          n.data = { hName: 'figure', hProperties: { className: ['n2-figure'], ...imageProps(img) } } as never;
          if (img.title) n.children = [img, { type: 'text', value: '', data: { hName: 'figcaption', hChildren: [{ type: 'text', value: img.title }] } } as never];
          else n.children = [img];
        }
      }
      if ('children' in n) walk(n as Parents);
    }
  };
  walk(tree);

  visit(tree, (node, index, parent) => {
    if (node.type === 'image') {
      const img = node as Image;
      const { path } = splitImageSrc(img.url);
      const props: Record<string, unknown> = { ...imageProps(img), loading: 'lazy', decoding: 'async' };
      if (isExternal(path)) {
        props.dataExternal = 'true';
        img.url = '';
      } else {
        const r = resolveLink(path, o.path, o.ctx);
        if (r.kind === 'asset' || r.kind === 'page') {
          img.url = assetSrc(r.path);
          props.dataPath = r.path;
        }
      }
      img.data = { hProperties: props } as never;
      return;
    }
    if (node.type === 'link') {
      const l = node as Link;
      const { rel, explicit } = parseRel(l.title);
      if (explicit) l.title = null;
      const r = resolveLink(l.url, o.path, o.ctx);
      const props: Record<string, unknown> = {};
      if (r.kind === 'external') {
        props.target = '_blank';
        props.rel = ['noopener', 'noreferrer'];
        props.dataExternal = 'true';
      } else if (r.kind === 'page') {
        l.url = pageHref(r.path, r.anchor);
        props.dataPage = r.path;
        props.dataRel = rel;
        if (o.ctx && !r.exists) props.dataBroken = 'true';
      } else if (r.kind === 'self') {
        l.url = `#${encodeURIComponent(r.anchor)}`;
      } else if (r.kind === 'asset') {
        l.url = assetSrc(r.path);
      }
      l.data = { hProperties: props } as never;
      return;
    }
    if (node.type === 'text' && parent && index !== undefined && o.ctx && !['link', 'linkReference'].includes(parent.type)) {
      const t = node as Text;
      if (!t.value.includes('[[')) return;
      const out: RootContent[] = [];
      let last = 0;
      for (const m of t.value.matchAll(new RegExp(WIKILINK_RE.source, 'g'))) {
        if (m.index! > last) out.push({ type: 'text', value: t.value.slice(last, m.index) });
        const target = (m[1] ?? '').trim();
        const res = resolveWikilink(target, o.ctx);
        const label = m[3]?.trim() || (m[2] ? `${target} > ${m[2].trim()}` : target);
        if (res.status === 'ok') out.push({ type: 'link', url: pageHref(res.page.path), children: [{ type: 'text', value: label }], data: { hProperties: { dataPage: res.page.path, dataRel: 'related' } } } as never);
        else out.push({ type: 'text', value: label, data: { hName: 'n2-wikilink', hProperties: { dataTarget: target, dataStatus: res.status } } } as never);
        last = m.index! + m[0].length;
      }
      if (last === 0) return;
      if (last < t.value.length) out.push({ type: 'text', value: t.value.slice(last) });
      (parent as Parents).children.splice(index, 1, ...(out as never[]));
      return index + out.length;
    }
    return undefined;
  });
}

const HTML_ALLOWED = new Set(['details', 'summary', 'kbd', 'sub', 'sup']);

function decodeEntities(s: string): string {
  return s.replace(/&(amp|lt|gt|quot|#39|nbsp);/g, (_m, e: string) => ({ amp: '&', lt: '<', gt: '>', quot: '"', '#39': "'", nbsp: '\u00a0' })[e]!);
}

/**
 * Turn raw HTML nodes into elements for the small allowlist (details, summary, kbd, sub, sup, br)
 * by grouping siblings between open and close tags. Everything else in raw HTML is dropped.
 * Replaces hast-util-raw (parse5), which is large for a Worker-adjacent bundle and unnecessary
 * when only six tags are allowed.
 */
export function groupHtml(parent: Parents): void {
  type Box = { tag: string; node: { children: RootContent[] } };
  const root: Box = { tag: '#root', node: { children: [] } };
  const stack: Box[] = [root];
  const top = () => stack[stack.length - 1]!.node.children;
  for (const child of parent.children as RootContent[]) {
    if (child.type !== 'html') {
      if ('children' in child) groupHtml(child as Parents);
      top().push(child);
      continue;
    }
    const v = child.value;
    const tags = findTags(v);
    let pos = 0;
    const text = (t: string) => {
      const clean = decodeEntities(t.replace(/^\n+|\n+$/g, ''));
      if (clean.trim()) top().push({ type: 'text', value: clean } as Text);
    };
    for (const t of tags) {
      text(v.slice(pos, t.index));
      const end = v.indexOf('>', t.index) + 1;
      pos = end > 0 ? end : v.length;
      if (t.tag === '!--') {
        const close = v.indexOf('-->', t.index);
        pos = close < 0 ? v.length : close + 3;
        continue;
      }
      if (t.tag === 'br' && !t.closing) {
        top().push({ type: 'break' } as RootContent);
        continue;
      }
      if (!HTML_ALLOWED.has(t.tag)) continue;
      if (!t.closing) {
        const props: Record<string, unknown> = t.tag === 'details' && t.attrs.includes('open') ? { open: true } : {};
        const node = { type: 'n2html', children: [] as RootContent[], data: { hName: t.tag, hProperties: props } };
        top().push(node as unknown as RootContent);
        stack.push({ tag: t.tag, node });
      } else {
        const i = stack.map((b) => b.tag).lastIndexOf(t.tag);
        if (i > 0) stack.length = i;
      }
    }
    text(v.slice(pos));
  }
  (parent as { children: RootContent[] }).children = root.node.children;
}

/** Sanitizer: GitHub-like defaults plus Nitrogen elements and data attributes. */
export const schema: Schema = {
  ...defaultSchema,
  tagNames: [...(defaultSchema.tagNames ?? []), 'details', 'summary', 'kbd', 'sub', 'sup', 'figure', 'figcaption', 'n2-callout', 'n2-drawer', 'n2-mermaid', 'n2-wikilink', 'mark'],
  attributes: {
    ...defaultSchema.attributes,
    '*': [...(defaultSchema.attributes?.['*'] ?? []), 'id', 'className', ['dataExternal', 'true'], 'dataPage', 'dataRel', 'dataBroken', 'dataPath', 'dataAlign', 'dataW', 'dataH', 'dataWrap', 'dataZoom', 'dataBorder'],
    a: [...(defaultSchema.attributes?.a ?? []), 'target', 'rel', 'title'],
    img: [...(defaultSchema.attributes?.img ?? []), 'loading', 'decoding', 'title'],
    details: ['open'],
    table: ['dataStyle', 'dataHeader', 'dataWidths', 'dataDense', 'dataWrap', 'dataCaption'],
    'n2-callout': ['dataType', 'dataUnknown', 'dataFold', 'dataTitle'],
    'n2-drawer': ['dataTitle', 'dataIcon', 'dataWidth'],
    'n2-mermaid': ['dataSource', 'dataTitle', 'dataCaption'],
    'n2-wikilink': ['dataTarget', 'dataStatus'],
    input: [...(defaultSchema.attributes?.input ?? [])],
  },
  protocols: { ...defaultSchema.protocols, src: ['http', 'https'] },
};

export interface Rendered {
  hast: HRoot;
  frontmatter: Record<string, unknown>;
}

/** Render CFM source to sanitized HAST with GitHub-compatible heading ids. */
export function renderToHast(src: string, o: RenderOptions): Rendered {
  const tree = parseMdast(src);
  transformCfm(tree, src, o);
  // Frontmatter is metadata, not content.
  tree.children = tree.children.filter((c) => c.type !== 'yaml');
  groupHtml(tree);
  let h = toHast(tree) as HRoot;
  h = sanitize(h, schema) as HRoot;
  const slugger = createSlugger();
  visit(h, 'element', (e: Element) => {
    if (/^h[1-6]$/.test(e.tagName)) {
      const text = textContent(e);
      e.properties = { ...e.properties, id: slugger.slug(text) };
    }
  });
  return { hast: h, frontmatter: frontmatterOf(src) };
}

export function textContent(n: ElementContent | HRoot): string {
  if (n.type === 'text') return n.value;
  if ('children' in n) return (n.children as ElementContent[]).map(textContent).join('');
  return '';
}

/** Static HTML (CLI export / tests). Drawers become <details>, mermaid a code block. */
export function renderToHtml(src: string, o: RenderOptions): string {
  const { hast } = renderToHast(src, o);
  visit(hast, 'element', (e: Element) => {
    if (e.tagName === 'n2-callout') {
      const p = e.properties as Record<string, string>;
      e.tagName = 'aside';
      e.properties = { className: ['callout', `callout-${p.dataType}`] };
      e.children = [el('p', { className: ['callout-title'] }, [{ type: 'text', value: p.dataTitle ?? '' }]), ...e.children];
    } else if (e.tagName === 'n2-drawer') {
      const p = e.properties as Record<string, string>;
      e.tagName = 'details';
      e.properties = { className: ['drawer'] };
      e.children = [el('summary', {}, [{ type: 'text', value: p.dataTitle ?? '' }]), ...e.children];
    } else if (e.tagName === 'n2-mermaid') {
      const p = e.properties as Record<string, string>;
      e.tagName = 'pre';
      e.properties = { className: ['mermaid'] };
      e.children = [{ type: 'text', value: p.dataSource ?? '' }];
    } else if (e.tagName === 'n2-wikilink') {
      e.tagName = 'span';
      e.properties = { className: ['wikilink-missing'] };
    }
  });
  return toHtml(hast);
}

export type { Element, HRoot, Html };
