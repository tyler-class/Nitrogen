import { basename, isExternal, normalizePath, resolvePath, splitHash, stripSlashes } from './paths.ts';
import { slugify } from './slug.ts';
import type { VaultContext, VaultPage } from './types.ts';

export type Resolved =
  | { kind: 'external'; href: string }
  | { kind: 'page'; path: string; anchor?: string; exists: boolean }
  | { kind: 'asset'; path: string; exists: boolean }
  | { kind: 'self'; anchor: string }
  | { kind: 'invalid'; reason: string };

/** Resolve an href found in `fromPath` against the vault. */
export function resolveLink(href: string, fromPath: string, ctx: VaultContext | null): Resolved {
  if (isExternal(href)) return { kind: 'external', href };
  const { path, hash } = splitHash(href);
  if (path === '') {
    if (hash === undefined) return { kind: 'invalid', reason: 'Empty link.' };
    return { kind: 'self', anchor: decodeSafe(hash) };
  }
  const resolved = resolvePath(path.split('?')[0]!, fromPath);
  if (resolved === null) return { kind: 'invalid', reason: 'Link escapes the repository root.' };
  const pages = ctx?.pages ?? [];
  if (resolved.endsWith('.md') || path.endsWith('/') || resolved === '') {
    let p = resolved;
    if (!p.endsWith('.md')) p = p ? `${p}/index.md` : 'index.md';
    const out: { kind: 'page'; path: string; anchor?: string; exists: boolean } = {
      kind: 'page',
      path: p,
      exists: pages.some((x) => x.path === p),
    };
    if (hash !== undefined && hash !== '') out.anchor = decodeSafe(hash);
    return out;
  }
  // Folder link without trailing slash.
  if (ctx && pages.some((x) => x.path === `${resolved}/index.md`)) {
    const out: { kind: 'page'; path: string; anchor?: string; exists: boolean } = {
      kind: 'page',
      path: `${resolved}/index.md`,
      exists: true,
    };
    if (hash) out.anchor = decodeSafe(hash);
    return out;
  }
  return { kind: 'asset', path: resolved, exists: ctx ? ctx.images.includes(resolved) : false };
}

function decodeSafe(s: string): string {
  try {
    return decodeURIComponent(s);
  } catch {
    return s;
  }
}

export type WikiResolution =
  | { status: 'ok'; page: VaultPage; via: 'path' | 'title' | 'alias' | 'basename' }
  | { status: 'self' }
  | { status: 'ambiguous'; candidates: VaultPage[] }
  | { status: 'missing' };

/** Resolve a wikilink target: exact path, exact title, alias, unique basename. */
export function resolveWikilink(target: string, ctx: VaultContext): WikiResolution {
  const t = target.trim();
  if (t === '') return { status: 'self' };
  const pages = ctx.pages;
  // 1. Exact path (with or without .md / leading slash).
  const asPath = normalizePath(stripSlashes(t));
  if (asPath) {
    const candidates = asPath.endsWith('.md') ? [asPath] : [`${asPath}.md`, `${asPath}/index.md`];
    for (const c of candidates) {
      const p = pages.find((x) => x.path === c);
      if (p) return { status: 'ok', page: p, via: 'path' };
    }
  }
  const lower = t.toLowerCase();
  // 2. Exact title.
  const byTitle = pages.filter((p) => p.title.toLowerCase() === lower);
  if (byTitle.length === 1) return { status: 'ok', page: byTitle[0]!, via: 'title' };
  if (byTitle.length > 1) return { status: 'ambiguous', candidates: byTitle };
  // 3. Alias.
  const byAlias = pages.filter((p) => p.aliases.some((a) => a.toLowerCase() === lower));
  if (byAlias.length === 1) return { status: 'ok', page: byAlias[0]!, via: 'alias' };
  if (byAlias.length > 1) return { status: 'ambiguous', candidates: byAlias };
  // 4. Unique basename.
  const base = lower.replace(/\.md$/, '');
  const byBase = pages.filter((p) => basename(p.path).replace(/\.md$/, '') === base);
  if (byBase.length === 1) return { status: 'ok', page: byBase[0]!, via: 'basename' };
  if (byBase.length > 1) return { status: 'ambiguous', candidates: byBase };
  return { status: 'missing' };
}

/** Canonical markdown for a resolved wikilink. */
export function canonicalWikilink(
  w: { target: string; anchor?: string; label?: string },
  res: WikiResolution,
  fromPath: string,
): string | null {
  let path: string;
  let base: string;
  if (res.status === 'ok') {
    path = res.page.path;
    base = res.via === 'path' ? res.page.title : w.target;
  } else if (res.status === 'self') {
    path = fromPath;
    base = '';
  } else return null;
  const frag = w.anchor ? `#${slugify(w.anchor)}` : '';
  let text = w.label ?? (w.anchor ? (base ? `${base} > ${w.anchor}` : w.anchor) : base);
  text = text.replace(/([[\]\\])/g, '\\$1');
  const href = res.status === 'self' ? frag : `/${path}${frag}`;
  return `[${text}](${encodeHref(href)})`;
}

/** Percent-encode characters that would break a markdown link destination. */
export function encodeHref(href: string): string {
  return href.replace(/[\s()<>]/g, (c) => encodeURIComponent(c));
}
