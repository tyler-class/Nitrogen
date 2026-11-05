import type { PageSummary } from './types';

export interface TreeNode {
  page: PageSummary;
  children: TreeNode[];
}

const collator = new Intl.Collator(undefined, { numeric: true, sensitivity: 'base' });

export function compareSiblings(a: PageSummary, b: PageSummary): number {
  return a.position - b.position || collator.compare(a.title, b.title);
}

/** Nest a flat page list. Pages whose parent is missing are treated as top level. */
export function buildTree(pages: PageSummary[]): TreeNode[] {
  const nodes = new Map(pages.map((p) => [p.id, { page: p, children: [] as TreeNode[] }]));
  const roots: TreeNode[] = [];
  for (const node of nodes.values()) {
    const parent = node.page.parent_id ? nodes.get(node.page.parent_id) : undefined;
    (parent ? parent.children : roots).push(node);
  }
  const sort = (list: TreeNode[]) => {
    list.sort((a, b) => compareSiblings(a.page, b.page));
    list.forEach((n) => sort(n.children));
  };
  sort(roots);
  return roots;
}

/** Ancestors of a page, root first, not including the page itself. Stops on cycles. */
export function ancestorsOf(id: string, byId: Map<string, PageSummary>): PageSummary[] {
  const out: PageSummary[] = [];
  const seen = new Set([id]);
  let cur = byId.get(id)?.parent_id ?? null;
  while (cur && !seen.has(cur)) {
    const p = byId.get(cur);
    if (!p) break;
    out.unshift(p);
    seen.add(cur);
    cur = p.parent_id;
  }
  return out;
}

/** An indented outline ("- Title (id)") for assistants. */
export function outline(roots: TreeNode[], depth = 0, maxDepth = Infinity): string[] {
  if (depth > maxDepth) return [];
  return roots.flatMap((n) => [
    `${'  '.repeat(depth)}- ${n.page.icon ? `${n.page.icon} ` : ''}${n.page.title} (${n.page.id})`,
    ...outline(n.children, depth + 1, maxDepth),
  ]);
}
