// Markdown → mdast (GFM) → wikilinks + callouts → hast → sanitized → React.
import { memo, useMemo, useState, type ComponentProps, type ReactNode } from 'react';
import { Fragment, jsx, jsxs } from 'react/jsx-runtime';
import { Link } from 'react-router';
import type { Blockquote, Link as MdLink, Paragraph, PhrasingContent, Root, Text } from 'mdast';
import { fromMarkdown } from 'mdast-util-from-markdown';
import { gfmFromMarkdown } from 'mdast-util-gfm';
import { toHast } from 'mdast-util-to-hast';
import { gfm } from 'micromark-extension-gfm';
import { defaultSchema, sanitize, type Schema } from 'hast-util-sanitize';
import { toJsxRuntime } from 'hast-util-to-jsx-runtime';
import { visit, SKIP } from 'unist-util-visit';
import { pageHref, slugify, splitTags, WIKILINK_RE } from '@shared/markdown';

const CALLOUTS = ['note', 'tip', 'important', 'warning', 'caution', 'info', 'question'];

/** Title (lowercased) → page, for resolving [[wikilinks]]. */
export type TitleIndex = Map<string, { id: string; title: string }>;

function headingText(node: { children?: unknown[] }): string {
  let out = '';
  visit(node as Root, 'text', (t: Text) => {
    out += t.value;
  });
  return out;
}

function transform(tree: Root, titles: TitleIndex) {
  // [[Wikilinks]] inside text nodes become links (or "missing" markers).
  visit(tree, 'text', (node: Text, index, parent) => {
    if (!parent || index === undefined || parent.type === 'link') return;
    const value = node.value;
    // Not WIKILINK_RE.test(): it moves the global regex's lastIndex, and matchAll below would
    // then start after the first link and find nothing.
    if (!value.includes('[[')) return;
    const parts: PhrasingContent[] = [];
    let last = 0;
    for (const m of value.matchAll(WIKILINK_RE)) {
      if (m.index > last) parts.push({ type: 'text', value: value.slice(last, m.index) });
      const target = m[1]!.trim();
      const page = titles.get(target.toLowerCase());
      const label = m[3]?.trim() || (m[2] ? `${target} › ${m[2].trim()}` : target);
      const link: MdLink = {
        type: 'link',
        url: page
          ? `${pageHref(page.id, page.title)}${m[2] ? `#h-${slugify(m[2])}` : ''}`
          : `#missing:${encodeURIComponent(target)}`,
        children: [{ type: 'text', value: label }],
        data: { hProperties: { className: page ? ['wikilink'] : ['wikilink', 'missing'] } },
      };
      parts.push(link);
      last = m.index + m[0].length;
    }
    if (last < value.length) parts.push({ type: 'text', value: value.slice(last) });
    parent.children.splice(index, 1, ...(parts as never[]));
    return [SKIP, index + parts.length];
  });

  // #tags become links to the tag's page.
  visit(tree, 'text', (node: Text, index, parent) => {
    if (!parent || index === undefined || parent.type === 'link') return;
    if (!node.value.includes('#')) return;
    const split = splitTags(node.value);
    if (split.length === 1 && 'text' in split[0]!) return;
    const parts: PhrasingContent[] = split.map((p) =>
      'text' in p
        ? { type: 'text', value: p.text }
        : {
            type: 'link',
            url: `/tags/${encodeURIComponent(p.tag)}`,
            children: [{ type: 'text', value: p.raw }],
            data: { hProperties: { className: ['tag'] } },
          },
    );
    parent.children.splice(index, 1, ...(parts as never[]));
    return [SKIP, index + parts.length];
  });

  // > [!NOTE] Optional title  →  <aside class="callout callout-note">
  visit(tree, 'blockquote', (node: Blockquote) => {
    const first = node.children[0];
    if (first?.type !== 'paragraph') return;
    const lead = first.children[0];
    if (lead?.type !== 'text') return;
    const m = /^\[!([A-Za-z]+)\][+-]?[ \t]*([^\n]*)\n?/.exec(lead.value);
    if (!m) return;
    const type = CALLOUTS.includes(m[1]!.toLowerCase()) ? m[1]!.toLowerCase() : 'note';
    lead.value = lead.value.slice(m[0].length);
    if (!lead.value) first.children.shift();
    // GFM alerts have no title; a bold-only first line is read as one.
    let title = m[2]!.trim();
    const bold = first.children[0];
    if (!title && bold?.type === 'strong') {
      title = headingText(bold);
      first.children.shift();
      const br = first.children[0];
      if (br?.type === 'break') first.children.shift();
      else if (br?.type === 'text') br.value = br.value.replace(/^\n/, '');
    }
    if (!first.children.length) node.children.shift();
    const titleNode: Paragraph = {
      type: 'paragraph',
      children: [{ type: 'text', value: title || type[0]!.toUpperCase() + type.slice(1) }],
      data: { hProperties: { className: ['callout-title'] } },
    };
    node.children.unshift(titleNode);
    node.data = { hName: 'aside', hProperties: { className: ['callout', `callout-${type}`] } };
  });

  // Heading anchors (the sanitizer prefixes them with "h-").
  const seen = new Map<string, number>();
  visit(tree, 'heading', (node) => {
    const base = slugify(headingText(node));
    const n = seen.get(base) ?? 0;
    seen.set(base, n + 1);
    node.data = { hProperties: { id: n ? `${base}-${n}` : base } };
  });
}

const schema: Schema = {
  ...defaultSchema,
  clobberPrefix: 'h-',
  tagNames: [...(defaultSchema.tagNames ?? []), 'aside'],
  attributes: {
    ...defaultSchema.attributes,
    // The default allows only one class on links; the first className rule wins, so replace it.
    a: [
      ...(defaultSchema.attributes?.a ?? []).filter(
        (x) => !(Array.isArray(x) && x[0] === 'className'),
      ),
      ['className', 'wikilink', 'missing', 'tag', 'data-footnote-backref'],
    ],
    aside: [['className', 'callout', ...CALLOUTS.map((c) => `callout-${c}`)]],
    p: [['className', 'callout-title']],
    code: [['className', /^language-./]],
  },
};

function Anchor({ href, children, ...rest }: ComponentProps<'a'>) {
  if (href?.startsWith('#missing:'))
    return (
      <span className="wikilink missing" title="No page has this title yet">
        {children}
      </span>
    );
  if (href?.startsWith('/') && !href.startsWith('//') && !href.startsWith('/files/'))
    return (
      <Link to={href} {...rest}>
        {children}
      </Link>
    );
  return (
    <a href={href} target="_blank" rel="noopener noreferrer" {...rest}>
      {children}
    </a>
  );
}

function Img({ src, alt, title }: ComponentProps<'img'>) {
  const [zoom, setZoom] = useState(false);
  return (
    <>
      <img
        src={src}
        alt={alt ?? ''}
        title={title}
        loading="lazy"
        decoding="async"
        onClick={() => setZoom(true)}
      />
      {zoom && (
        <button className="lightbox" onClick={() => setZoom(false)} aria-label="Close image">
          <img src={src} alt={alt ?? ''} />
        </button>
      )}
    </>
  );
}

function TableWrap(props: ComponentProps<'table'>) {
  return (
    <div className="table-wrap">
      <table {...props} />
    </div>
  );
}

export const Markdown = memo(function Markdown({
  source,
  titles,
}: {
  source: string;
  titles: TitleIndex;
}): ReactNode {
  return useMemo(() => {
    const tree = fromMarkdown(source, {
      extensions: [gfm()],
      mdastExtensions: [gfmFromMarkdown()],
    });
    transform(tree, titles);
    const hast = sanitize(toHast(tree), schema);
    return toJsxRuntime(hast, {
      Fragment,
      jsx,
      jsxs,
      components: { a: Anchor, img: Img, table: TableWrap },
    });
  }, [source, titles]);
});
