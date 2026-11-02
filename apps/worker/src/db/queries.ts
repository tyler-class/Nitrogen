/** Read queries over the index. Everything is SQL on D1; no page parsing at request time. */
import { toRecord, type PageRecord } from './store.ts';

export interface Selector {
  under?: string;
  tag?: string;
  status?: string;
  paths?: string[];
}

/** WHERE fragment + params selecting pages by folder/tag/status/paths (alias `p`). */
export function selectorSql(sel: Selector, alias = 'p'): { sql: string; params: unknown[] } {
  const parts: string[] = [];
  const params: unknown[] = [];
  if (sel.under) {
    const u = sel.under.replace(/^\/+|\/+$/g, '');
    if (u) {
      parts.push(`(${alias}.path = ? OR ${alias}.path LIKE ?)`);
      params.push(`${u}.md`, `${u}/%`);
    }
  }
  if (sel.tag) {
    parts.push(`EXISTS (SELECT 1 FROM json_each(${alias}.tags) WHERE value = ?)`);
    params.push(sel.tag);
  }
  if (sel.status) {
    parts.push(`${alias}.status = ?`);
    params.push(sel.status);
  }
  if (sel.paths && sel.paths.length) {
    parts.push(`${alias}.path IN (${sel.paths.map(() => '?').join(',')})`);
    params.push(...sel.paths);
  }
  return { sql: parts.length ? parts.join(' AND ') : '1=1', params };
}

function relFilter(rels: string[] | undefined, alias = 'l'): { sql: string; params: unknown[] } {
  if (!rels || rels.length === 0) return { sql: '1=1', params: [] };
  return { sql: `${alias}.rel IN (${rels.map(() => '?').join(',')})`, params: rels };
}

export class Queries {
  constructor(readonly db: D1Database) {}

  async tree(): Promise<Pick<PageRecord, 'path' | 'title' | 'icon' | 'ord' | 'status' | 'pinned' | 'locked' | 'tags' | 'aliases'>[]> {
    const r = await this.db.prepare('SELECT path, title, icon, ord, status, pinned, locked, tags, aliases FROM pages ORDER BY path').all<Record<string, unknown>>();
    return r.results.map((x) => ({
      path: x.path as string,
      title: x.title as string,
      icon: (x.icon as string) ?? null,
      ord: (x.ord as number) ?? null,
      status: (x.status as string) ?? null,
      pinned: !!x.pinned,
      locked: !!x.locked,
      tags: JSON.parse((x.tags as string) || '[]') as string[],
      aliases: JSON.parse((x.aliases as string) || '[]') as string[],
    }));
  }

  async backlinks(path: string, rels?: string[]) {
    const rf = relFilter(rels);
    const r = await this.db
      .prepare(`SELECT l.src, l.rel, l.text, l.ctx, l.frag, l.line, p.title FROM links l JOIN pages p ON p.path = l.src WHERE l.dst = ? AND l.src != ? AND ${rf.sql} ORDER BY p.title, l.line`)
      .bind(path, path, ...rf.params)
      .all<{ src: string; rel: string; text: string; ctx: string; frag: string | null; line: number; title: string }>();
    return group(r.results.map((x) => ({ other: x.src, title: x.title, rel: x.rel, text: x.text, ctx: x.ctx, frag: x.frag, line: x.line })));
  }

  async outgoing(path: string, rels?: string[]) {
    const rf = relFilter(rels);
    const r = await this.db
      .prepare(`SELECT l.dst, l.rel, l.text, l.ctx, l.frag, l.line, p.title FROM links l LEFT JOIN pages p ON p.path = l.dst WHERE l.src = ? AND ${rf.sql} ORDER BY l.line`)
      .bind(path, ...rf.params)
      .all<{ dst: string; rel: string; text: string; ctx: string; frag: string | null; line: number; title: string | null }>();
    return group(r.results.map((x) => ({ other: x.dst, title: x.title, broken: x.title === null, rel: x.rel, text: x.text, ctx: x.ctx, frag: x.frag, line: x.line })));
  }

  /** List lens: incoming and/or outgoing links grouped by the other page, filtered by scope. */
  async links(page: string, dir: 'in' | 'out' | 'both', rels: string[] | undefined, scope: Selector) {
    const sel = selectorSql(scope, 'o');
    const rf = relFilter(rels);
    const out: { incoming?: ReturnType<typeof group>; outgoing?: ReturnType<typeof group> } = {};
    if (dir !== 'out') {
      const r = await this.db
        .prepare(`SELECT l.src AS other, o.title, l.rel, l.text, l.ctx, l.frag, l.line FROM links l JOIN pages o ON o.path = l.src WHERE l.dst = ? AND l.src != ? AND ${rf.sql} AND ${sel.sql} ORDER BY o.title, l.line`)
        .bind(page, page, ...rf.params, ...sel.params)
        .all<{ other: string; title: string; rel: string; text: string; ctx: string; frag: string | null; line: number }>();
      out.incoming = group(r.results);
    }
    if (dir !== 'in') {
      const scoped = sel.sql === '1=1' ? 'LEFT JOIN' : 'JOIN';
      const r = await this.db
        .prepare(`SELECT l.dst AS other, o.title, l.rel, l.text, l.ctx, l.frag, l.line FROM links l ${scoped} pages o ON o.path = l.dst WHERE l.src = ? AND ${rf.sql} AND ${sel.sql} ORDER BY l.line`)
        .bind(page, ...rf.params, ...sel.params)
        .all<{ other: string; title: string | null; rel: string; text: string; ctx: string; frag: string | null; line: number }>();
      out.outgoing = group(r.results.map((x) => ({ ...x, broken: x.title === null })));
    }
    return out;
  }

  /** Cross view: counts of links from each row page to each column page. */
  async matrix(rows: Selector, cols: Selector, rels?: string[], cap = 200) {
    const rs = selectorSql(rows, 'p');
    const cs = selectorSql(cols, 'p');
    const [rowPages, colPages] = await Promise.all([
      this.db.prepare(`SELECT p.path, p.title FROM pages p WHERE ${rs.sql} ORDER BY p.path LIMIT ?`).bind(...rs.params, cap + 1).all<{ path: string; title: string }>(),
      this.db.prepare(`SELECT p.path, p.title FROM pages p WHERE ${cs.sql} ORDER BY p.path LIMIT ?`).bind(...cs.params, cap + 1).all<{ path: string; title: string }>(),
    ]);
    if (rowPages.results.length > cap || colPages.results.length > cap) return { tooLarge: true as const, cap };
    const rf = relFilter(rels);
    const rsl = selectorSql(rows, 'a');
    const csl = selectorSql(cols, 'b');
    const counts = await this.db
      .prepare(`SELECT l.src, l.dst, COUNT(*) AS n FROM links l JOIN pages a ON a.path = l.src JOIN pages b ON b.path = l.dst WHERE ${rsl.sql} AND ${csl.sql} AND ${rf.sql} GROUP BY l.src, l.dst`)
      .bind(...rsl.params, ...csl.params, ...rf.params)
      .all<{ src: string; dst: string; n: number }>();
    const rowTotals: Record<string, number> = {};
    const colTotals: Record<string, number> = {};
    for (const c of counts.results) {
      rowTotals[c.src] = (rowTotals[c.src] ?? 0) + c.n;
      colTotals[c.dst] = (colTotals[c.dst] ?? 0) + c.n;
    }
    return {
      tooLarge: false as const,
      rows: rowPages.results,
      cols: colPages.results,
      cells: counts.results,
      rowTotals,
      colTotals,
      emptyRows: rowPages.results.filter((r) => !rowTotals[r.path]).map((r) => r.path),
      emptyCols: colPages.results.filter((c) => !colTotals[c.path]).map((c) => c.path),
    };
  }

  async cell(src: string, dst: string, rels?: string[]) {
    const rf = relFilter(rels);
    return (await this.db.prepare(`SELECT l.src, l.dst, l.rel, l.text, l.ctx, l.frag, l.line FROM links l WHERE l.src = ? AND l.dst = ? AND ${rf.sql} ORDER BY l.line`).bind(src, dst, ...rf.params).all()).results;
  }

  /** Nodes and typed edges within `depth` hops (1 or 2), capped at `limit` nodes. */
  async neighborhood(page: string, depth: 1 | 2, rels: string[] | undefined, limit = 40) {
    const rf = relFilter(rels);
    const edges1 = await this.db
      .prepare(`SELECT l.src, l.dst, l.rel, COUNT(*) AS n FROM links l WHERE (l.src = ? OR l.dst = ?) AND l.src != l.dst AND ${rf.sql} GROUP BY l.src, l.dst, l.rel`)
      .bind(page, page, ...rf.params)
      .all<{ src: string; dst: string; rel: string; n: number }>();
    let edges = edges1.results;
    const nodes = new Set<string>([page]);
    for (const e of edges) {
      nodes.add(e.src);
      nodes.add(e.dst);
    }
    let truncated = false;
    if (depth === 2 && nodes.size > 1) {
      const first = [...nodes].filter((n) => n !== page).slice(0, 90);
      const ph = first.map(() => '?').join(',');
      const e2 = await this.db
        .prepare(`SELECT l.src, l.dst, l.rel, COUNT(*) AS n FROM links l WHERE (l.src IN (${ph}) OR l.dst IN (${ph})) AND l.src != l.dst AND ${rf.sql} GROUP BY l.src, l.dst, l.rel LIMIT 2000`)
        .bind(...first, ...first, ...rf.params)
        .all<{ src: string; dst: string; rel: string; n: number }>();
      for (const e of e2.results) {
        if (nodes.size >= limit && (!nodes.has(e.src) || !nodes.has(e.dst))) {
          truncated = true;
          continue;
        }
        nodes.add(e.src);
        nodes.add(e.dst);
      }
      const seen = new Set(edges.map((e) => `${e.src}|${e.dst}|${e.rel}`));
      for (const e of e2.results) if (nodes.has(e.src) && nodes.has(e.dst) && !seen.has(`${e.src}|${e.dst}|${e.rel}`)) edges.push(e);
    }
    if (nodes.size > limit) {
      truncated = true;
      const keep = new Set([page, ...[...nodes].filter((n) => n !== page).slice(0, limit - 1)]);
      edges = edges.filter((e) => keep.has(e.src) && keep.has(e.dst));
      nodes.clear();
      keep.forEach((n) => nodes.add(n));
    }
    const ids = [...nodes];
    const info = ids.length
      ? await this.db.prepare(`SELECT path, title, excerpt, status FROM pages WHERE path IN (${ids.map(() => '?').join(',')})`).bind(...ids).all<{ path: string; title: string; excerpt: string; status: string | null }>()
      : { results: [] };
    const byPath = new Map(info.results.map((r) => [r.path, r]));
    return {
      center: page,
      nodes: ids.map((id) => ({ path: id, title: byPath.get(id)?.title ?? id, excerpt: byPath.get(id)?.excerpt ?? '', status: byPath.get(id)?.status ?? null, missing: !byPath.has(id) })),
      edges,
      truncated,
    };
  }

  /** Shared neighbors and shortest undirected link path (BFS, max depth 4). */
  async compare(a: string, b: string) {
    const cocite = await this.db
      .prepare('SELECT x.src AS path, p.title FROM links x JOIN links y ON x.src = y.src JOIN pages p ON p.path = x.src WHERE x.dst = ? AND y.dst = ? GROUP BY x.src')
      .bind(a, b)
      .all<{ path: string; title: string }>();
    const shared = await this.db
      .prepare('SELECT x.dst AS path, p.title FROM links x JOIN links y ON x.dst = y.dst LEFT JOIN pages p ON p.path = x.dst WHERE x.src = ? AND y.src = ? GROUP BY x.dst')
      .bind(a, b)
      .all<{ path: string; title: string | null }>();
    const path = await this.shortestPath(a, b, 4);
    return { coCitation: cocite.results, sharedReferences: shared.results, path };
  }

  async shortestPath(a: string, b: string, maxDepth: number): Promise<{ path: string; via: 'out' | 'in' | null }[] | null> {
    if (a === b) return [{ path: a, via: null }];
    const prev = new Map<string, { from: string; via: 'out' | 'in' }>();
    let frontier = [a];
    const seen = new Set([a]);
    for (let d = 0; d < maxDepth && frontier.length; d++) {
      const ph = frontier.map(() => '?').join(',');
      const r = await this.db
        .prepare(`SELECT DISTINCT src, dst FROM links WHERE src IN (${ph}) OR dst IN (${ph}) LIMIT 5000`)
        .bind(...frontier, ...frontier)
        .all<{ src: string; dst: string }>();
      const next: string[] = [];
      const fset = new Set(frontier);
      for (const e of r.results) {
        const hops: [string, string, 'out' | 'in'][] = [];
        if (fset.has(e.src)) hops.push([e.src, e.dst, 'out']);
        if (fset.has(e.dst)) hops.push([e.dst, e.src, 'in']);
        for (const [from, to, via] of hops) {
          if (seen.has(to)) continue;
          seen.add(to);
          prev.set(to, { from, via });
          next.push(to);
        }
      }
      if (seen.has(b)) {
        const out: { path: string; via: 'out' | 'in' | null }[] = [];
        let cur = b;
        while (cur !== a) {
          const p = prev.get(cur)!;
          out.unshift({ path: cur, via: p.via });
          cur = p.from;
        }
        out.unshift({ path: a, via: null });
        return out;
      }
      frontier = next.slice(0, 90);
    }
    return null;
  }

  /** Pages that mention the title or an alias in their body without linking to the page. */
  async unlinked(page: string, limit = 20) {
    const p = await this.db.prepare('SELECT title, aliases FROM pages WHERE path = ?').bind(page).first<{ title: string; aliases: string }>();
    if (!p) return [];
    const names = [p.title, ...(JSON.parse(p.aliases) as string[])].filter((n) => n.trim().length >= 3);
    const out: { path: string; title: string; mention: string; snippet: string }[] = [];
    const seen = new Set<string>();
    for (const name of names) {
      const phrase = `"${name.replace(/"/g, '""')}"`;
      const r = await this.db
        .prepare(
          `SELECT f.path, p.title, f.body, snippet(pages_fts, 3, '<<', '>>', '…', 16) AS snip FROM pages_fts f JOIN pages p ON p.path = f.path
           WHERE pages_fts MATCH ? AND f.path != ? AND NOT EXISTS (SELECT 1 FROM links l WHERE l.src = f.path AND l.dst = ?) LIMIT ?`,
        )
        .bind(`body : ${phrase}`, page, page, limit * 2)
        .all<{ path: string; title: string; body: string; snip: string }>();
      const re = new RegExp(`(?<![\\p{L}\\p{N}_])${name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?![\\p{L}\\p{N}_])`, 'iu');
      for (const x of r.results) {
        if (seen.has(x.path)) continue;
        const m = re.exec(x.body);
        if (!m) continue; // FTS tokenization is looser than a phrase match; verify.
        seen.add(x.path);
        out.push({ path: x.path, title: x.title, mention: m[0], snippet: x.snip });
        if (out.length >= limit) return out;
      }
    }
    return out;
  }

  async search(q: string, limit = 20) {
    const { text, filters } = parseQuery(q);
    const sel = selectorSql(filters, 'p');
    if (!text) {
      const r = await this.db.prepare(`SELECT p.path, p.title, p.excerpt AS snippet FROM pages p WHERE ${sel.sql} ORDER BY p.title LIMIT ?`).bind(...sel.params, limit).all();
      return r.results;
    }
    const r = await this.db
      .prepare(
        `SELECT f.path, p.title, p.status, snippet(pages_fts, 3, '<mark>', '</mark>', '…', 20) AS snippet, bm25(pages_fts, 0, 8.0, 4.0, 1.0, 4.0) AS score
         FROM pages_fts f JOIN pages p ON p.path = f.path WHERE pages_fts MATCH ? AND ${sel.sql} ORDER BY score LIMIT ?`,
      )
      .bind(ftsQuery(text), ...sel.params, limit)
      .all();
    return r.results;
  }

  async headings(path: string) {
    return (await this.db.prepare('SELECT slug, text, level FROM headings WHERE path = ? ORDER BY rowid').bind(path).all<{ slug: string; text: string; level: number }>()).results;
  }

  async brokenLinks() {
    return (await this.db.prepare('SELECT l.src, l.dst, l.text, l.line FROM links l LEFT JOIN pages p ON p.path = l.dst WHERE p.path IS NULL ORDER BY l.src, l.line').all()).results;
  }

  async tags() {
    return (await this.db.prepare('SELECT value AS tag, COUNT(*) AS n FROM pages, json_each(pages.tags) GROUP BY value ORDER BY n DESC, tag').all<{ tag: string; n: number }>()).results;
  }

  async activity(limit = 50, actor?: string, before?: number) {
    const parts = ['1=1'];
    const params: unknown[] = [];
    if (actor) {
      parts.push('actor = ?');
      params.push(actor);
    }
    if (before) {
      parts.push('id < ?');
      params.push(before);
    }
    return (await this.db.prepare(`SELECT * FROM activity WHERE ${parts.join(' AND ')} ORDER BY id DESC LIMIT ?`).bind(...params, limit).all()).results;
  }

  async recentPages(limit = 20) {
    return (await this.db.prepare("SELECT path, MAX(at) AS at, actor FROM activity WHERE path LIKE '%.md' GROUP BY path ORDER BY at DESC LIMIT ?").bind(limit).all()).results;
  }

  async pageRecord(path: string) {
    const r = await this.db.prepare('SELECT * FROM pages WHERE path = ?').bind(path).first();
    return r ? toRecord(r as never) : null;
  }
}

function group<T extends { other: string; title: string | null }>(rows: T[]) {
  const m = new Map<string, { path: string; title: string | null; count: number; links: Omit<T, 'other' | 'title'>[] }>();
  for (const { other, title, ...rest } of rows) {
    const g = m.get(other) ?? m.set(other, { path: other, title, count: 0, links: [] }).get(other)!;
    g.count++;
    g.links.push(rest);
  }
  return [...m.values()];
}

export function parseQuery(q: string): { text: string; filters: Selector } {
  const filters: Selector = {};
  const text = q
    .replace(/\b(under|tag|status):("[^"]+"|\S+)/g, (_m, k: string, v: string) => {
      const val = v.replace(/^"|"$/g, '');
      if (k === 'under') filters.under = val;
      else if (k === 'tag') filters.tag = val;
      else filters.status = val;
      return ' ';
    })
    .trim();
  return { text, filters };
}

/** Turn free text into a safe FTS5 query: quoted terms, prefix match on the last one. */
export function ftsQuery(text: string): string {
  const terms = text.match(/[\p{L}\p{N}_]+/gu) ?? [];
  if (terms.length === 0) return '""';
  return terms.map((t, i) => `"${t}"${i === terms.length - 1 ? '*' : ''}`).join(' ');
}
