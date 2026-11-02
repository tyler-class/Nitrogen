/** Path helpers. All vault paths are POSIX, root-relative, without a leading slash. */

const MAX_PATH = 400;

export function stripSlashes(p: string): string {
  return p.replace(/^\/+/, '').replace(/\/+$/, '');
}

/** Normalize `a/./b/../c` and collapse slashes. Returns null if the path escapes the root. */
export function normalizePath(p: string): string | null {
  const out: string[] = [];
  for (const seg of p.split('/')) {
    if (seg === '' || seg === '.') continue;
    if (seg === '..') {
      if (out.length === 0) return null;
      out.pop();
    } else out.push(seg);
  }
  return out.join('/');
}

export function dirname(p: string): string {
  const i = p.lastIndexOf('/');
  return i < 0 ? '' : p.slice(0, i);
}

export function basename(p: string): string {
  const i = p.lastIndexOf('/');
  return i < 0 ? p : p.slice(i + 1);
}

export function extname(p: string): string {
  const b = basename(p);
  const i = b.lastIndexOf('.');
  return i <= 0 ? '' : b.slice(i).toLowerCase();
}

/** Resolve an href path (root-relative or page-relative) against the page that contains it. */
export function resolvePath(href: string, fromPath: string): string | null {
  let decoded = href;
  try {
    decoded = decodeURI(href);
  } catch {
    /* keep raw */
  }
  if (decoded.startsWith('/')) return normalizePath(decoded);
  return normalizePath(`${dirname(fromPath)}/${decoded}`);
}

/** Relative path from the directory of `fromPath` to `toPath`. */
export function relativePath(fromPath: string, toPath: string): string {
  const from = dirname(fromPath).split('/').filter(Boolean);
  const to = toPath.split('/').filter(Boolean);
  let i = 0;
  while (i < from.length && i < to.length - 1 && from[i] === to[i]) i++;
  const up = from.length - i;
  const rest = to.slice(i).join('/');
  return up === 0 ? rest : `${'../'.repeat(up)}${rest}`;
}

export function isExternal(href: string): boolean {
  return /^[a-z][a-z0-9+.-]*:/i.test(href) || href.startsWith('//');
}

export function splitHash(href: string): { path: string; hash: string | undefined } {
  const i = href.indexOf('#');
  if (i < 0) return { path: href, hash: undefined };
  return { path: href.slice(0, i), hash: href.slice(i + 1) };
}

export const KEBAB_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*\.md$/;

export function isKebabFileName(path: string): boolean {
  return KEBAB_RE.test(basename(path));
}

/** Suggest a kebab-case file name for a path. */
export function kebabSuggestion(path: string): string {
  const dir = dirname(path);
  const base = basename(path).replace(/\.md$/i, '');
  const slug =
    base
      .normalize('NFKD')
      .replace(/[̀-ͯ]/g, '')
      .replace(/([a-z0-9])([A-Z])/g, '$1-$2')
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '') || 'page';
  return dir ? `${dir}/${slug}.md` : `${slug}.md`;
}

/** True when the first path segment (or any segment) is ignored or hidden. */
export function isIgnoredPath(path: string, ignore: string[]): boolean {
  const segs = path.split('/');
  if (segs.some((s) => s.startsWith('.') || s.startsWith('_'))) return true;
  const top = segs[0] ?? '';
  return ignore.some((ig) => {
    const clean = stripSlashes(ig);
    return top === clean || path === clean || path.startsWith(`${clean}/`);
  });
}

export interface PathCheck {
  ok: boolean;
  reason?: string;
}

/**
 * Validate a page write path (E009). Pages must be `.md`, inside the content root, not ignored,
 * not reserved.
 */
export function checkPagePath(path: string, ignore: string[]): PathCheck {
  if (!path || path.length > MAX_PATH) return { ok: false, reason: 'Path is empty or too long.' };
  if (path.startsWith('/') || path.includes('\\') || path.includes('\0'))
    return { ok: false, reason: 'Use a root-relative path without a leading slash.' };
  const norm = normalizePath(path);
  if (norm === null || norm !== path) return { ok: false, reason: 'Path must be normalized and stay inside the repo.' };
  if (!path.endsWith('.md')) return { ok: false, reason: 'Pages must have the .md extension.' };
  if (isIgnoredPath(path, ignore)) return { ok: false, reason: 'Path is in an ignored or reserved folder.' };
  const reserved = ['FORMAT.md', 'CLAUDE.md', 'README.md'];
  if (reserved.includes(path)) return { ok: false, reason: `${path} is reserved.` };
  return { ok: true };
}

/** Validate an asset path under the assets dir. */
export function checkAssetPath(path: string, assetsDir: string, formats: string[]): PathCheck {
  const norm = normalizePath(path);
  if (norm === null || norm !== path || path.startsWith('/'))
    return { ok: false, reason: 'Path must be normalized and stay inside the repo.' };
  const dir = stripSlashes(assetsDir);
  if (!path.startsWith(`${dir}/`)) return { ok: false, reason: `Images live under /${dir}/.` };
  const ext = extname(path).slice(1);
  if (!formats.includes(ext)) return { ok: false, reason: `Image type .${ext} is not allowed.` };
  if (path.split('/').some((s) => s.startsWith('.'))) return { ok: false, reason: 'Hidden paths are not allowed.' };
  return { ok: true };
}

/** Title-case a folder or file name: `sync-design` -> `Sync design`. */
export function titleFromName(name: string): string {
  const base = name.replace(/\.md$/i, '').replace(/[-_]+/g, ' ').trim();
  if (!base) return 'Untitled';
  return base.charAt(0).toUpperCase() + base.slice(1);
}
