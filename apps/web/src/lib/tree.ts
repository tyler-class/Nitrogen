import type { TreePage } from '../api/types.ts';

export interface TreeNode {
  /** Folder path ('' for root) or page path. */
  id: string;
  kind: 'folder' | 'page';
  title: string;
  icon: string | null;
  status: string | null;
  ord: number | null;
  /** Page path for pages, folder index path when the folder has one. */
  page: string | null;
  children: TreeNode[];
}

const collator = new Intl.Collator(undefined, { numeric: true, sensitivity: 'base' });

export function titleCase(name: string): string {
  const s = name.replace(/[-_]+/g, ' ').trim();
  return s ? s[0]!.toUpperCase() + s.slice(1) : 'Untitled';
}

/** Spec 5.3: siblings by order (missing last), then natural title order. */
export function compareNodes(a: { ord: number | null; title: string }, b: { ord: number | null; title: string }): number {
  if (a.ord !== null && b.ord !== null && a.ord !== b.ord) return a.ord - b.ord;
  if (a.ord !== null && b.ord === null) return -1;
  if (a.ord === null && b.ord !== null) return 1;
  return collator.compare(a.title, b.title);
}

/** Build the page tree. The root index.md is the home page and not listed as a child. */
export function buildTree(pages: TreePage[]): TreeNode {
  const root: TreeNode = { id: '', kind: 'folder', title: 'Home', icon: null, status: null, ord: null, page: null, children: [] };
  const folders = new Map<string, TreeNode>([['', root]]);
  const folder = (path: string): TreeNode => {
    const hit = folders.get(path);
    if (hit) return hit;
    const parentPath = path.includes('/') ? path.slice(0, path.lastIndexOf('/')) : '';
    const name = path.slice(path.lastIndexOf('/') + 1);
    const node: TreeNode = { id: path, kind: 'folder', title: titleCase(name), icon: null, status: null, ord: null, page: null, children: [] };
    folders.set(path, node);
    folder(parentPath).children.push(node);
    return node;
  };
  for (const p of pages) {
    const dir = p.path.includes('/') ? p.path.slice(0, p.path.lastIndexOf('/')) : '';
    if (p.path.endsWith('/index.md') || p.path === 'index.md') {
      const f = folder(dir);
      f.page = p.path;
      f.title = p.title;
      f.icon = p.icon;
      f.ord = p.ord;
      f.status = p.status;
      continue;
    }
    folder(dir).children.push({ id: p.path, kind: 'page', title: p.title, icon: p.icon, status: p.status, ord: p.ord, page: p.path, children: [] });
  }
  const sort = (n: TreeNode) => {
    n.children.sort(compareNodes);
    n.children.forEach(sort);
  };
  sort(root);
  return root;
}

/** Flatten visible rows for keyboard navigation / virtualization. */
export function visibleRows(root: TreeNode, expanded: Set<string>, depth = 0, out: { node: TreeNode; depth: number }[] = []): { node: TreeNode; depth: number }[] {
  for (const c of root.children) {
    out.push({ node: c, depth });
    if (c.kind === 'folder' && expanded.has(c.id)) visibleRows(c, expanded, depth + 1, out);
  }
  return out;
}

/** Ancestors (folder ids) of a page path, for auto-expanding the active page. */
export function ancestorsOf(path: string): string[] {
  const segs = path.split('/').slice(0, -1);
  return segs.map((_, i) => segs.slice(0, i + 1).join('/'));
}

/** Siblings for prev/next navigation. */
export function siblingsOf(root: TreeNode, path: string): { prev: TreeNode | null; next: TreeNode | null } {
  if (path === 'index.md') return { prev: null, next: null };
  const own = path.endsWith('/index.md') ? path.slice(0, -'/index.md'.length) : path;
  const parentId = own.includes('/') ? own.slice(0, own.lastIndexOf('/')) : '';
  const find = (n: TreeNode): TreeNode | null => {
    if (n.kind === 'folder' && n.id === parentId) return n;
    for (const c of n.children) {
      const f = c.kind === 'folder' ? find(c) : null;
      if (f) return f;
    }
    return null;
  };
  const list = (find(root) ?? root).children.filter((c) => c.page);
  const i = list.findIndex((c) => c.page === path);
  return { prev: i > 0 ? list[i - 1]! : null, next: i >= 0 && i < list.length - 1 ? list[i + 1]! : null };
}

export function pageHref(path: string, anchor?: string): string {
  return `/p/${path.split('/').map(encodeURIComponent).join('/')}${anchor ? `#${encodeURIComponent(anchor)}` : ''}`;
}

export function crumbs(path: string, titleOf: (p: string) => string | undefined): { label: string; href: string | null }[] {
  const segs = path.split('/');
  const out: { label: string; href: string | null }[] = [{ label: titleOf('index.md') ?? 'Home', href: '/' }];
  for (let i = 0; i < segs.length - 1; i++) {
    const dir = segs.slice(0, i + 1).join('/');
    const idx = `${dir}/index.md`;
    const t = titleOf(idx);
    out.push({ label: t ?? titleCase(segs[i]!), href: t ? pageHref(idx) : null });
  }
  return path.endsWith('/index.md') ? out.slice(0, -1) : out;
}
