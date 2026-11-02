import { deriveMeta } from './frontmatter.ts';
import { resolveLink } from './resolve.ts';
import { bodyText, contextAt, excerpt } from './text.ts';
import { splitImageSrc } from './syntax.ts';
import type { PageMeta, PageScan, VaultContext } from './types.ts';

export interface PageRow {
  path: string;
  sha: string;
  title: string;
  icon: string | null;
  ord: number | null;
  status: string | null;
  tags: string[];
  aliases: string[];
  pinned: boolean;
  locked: boolean;
  excerpt: string;
  body: string;
  size: number;
  updated: string | null;
}

export interface LinkRow {
  src: string;
  dst: string;
  frag: string | null;
  rel: string;
  text: string;
  ctx: string;
  line: number;
}

export interface ImageRow {
  src: string;
  path: string;
}

export interface HeadingRow {
  path: string;
  slug: string;
  text: string;
  level: number;
}

export interface IndexRows {
  page: PageRow;
  links: LinkRow[];
  images: ImageRow[];
  headings: HeadingRow[];
  /** Search text: title, headings, body, tags. */
  text: string;
  meta: PageMeta;
}

/** Extract D1 rows for one page from a scan (either parser mode). */
export function indexRowsFromScan(path: string, src: string, sha: string, scan: PageScan, ctx: VaultContext | null = null): IndexRows {
  const h1 = scan.headings.find((h) => h.level === 1)?.text;
  const meta = deriveMeta(scan.frontmatter, h1, path);
  const lines = src.split('\n');
  const body = bodyText(src);
  const page: PageRow = {
    path,
    sha,
    title: meta.title,
    icon: meta.icon ?? null,
    ord: meta.order ?? null,
    status: meta.status ?? null,
    tags: meta.tags,
    aliases: meta.aliases,
    pinned: meta.pinned,
    locked: meta.locked,
    excerpt: excerpt(src),
    body,
    size: new TextEncoder().encode(src).length,
    updated: meta.updated ?? null,
  };
  const links: LinkRow[] = [];
  for (const l of scan.links) {
    if (l.external) continue;
    const r = resolveLink(l.href, path, ctx);
    if (r.kind !== 'page') continue;
    if (r.path === path && !r.anchor) continue;
    if (r.path === path) continue;
    links.push({
      src: path,
      dst: r.path,
      frag: r.anchor ?? null,
      rel: l.rel,
      text: l.text,
      ctx: contextAt(lines, l.line, l.text),
      line: l.line,
    });
  }
  const images: ImageRow[] = [];
  for (const img of scan.images) {
    const { path: p } = splitImageSrc(img.src);
    const r = resolveLink(p, path, ctx);
    if (r.kind === 'asset' || r.kind === 'page') images.push({ src: path, path: r.path });
  }
  const headings: HeadingRow[] = scan.headings.map((h) => ({ path, slug: h.slug, text: h.text, level: h.level }));
  const text = [meta.title, ...headings.map((h) => h.text), body, meta.tags.join(' ')].join('\n');
  return { page, links, images, headings, text, meta };
}
