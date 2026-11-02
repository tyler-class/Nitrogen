/** D1 index store. D1 is a cache of the repo; every row here can be rebuilt from git. */
import { indexRowsFromScan, scanPage, parseConfig, type IndexRows, type NitrogenConfig, type VaultContext } from '@nitrogen/core/light';

export interface PageRecord {
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
  excerpt: string | null;
  size: number | null;
  updated_at: string | null;
  last_actor: string | null;
}

interface PageRowDb {
  path: string;
  sha: string;
  title: string;
  icon: string | null;
  ord: number | null;
  status: string | null;
  tags: string;
  aliases: string;
  pinned: number;
  locked: number;
  excerpt: string | null;
  size: number | null;
  updated_at: string | null;
  last_actor: string | null;
}

export function toRecord(r: PageRowDb): PageRecord {
  return { ...r, tags: JSON.parse(r.tags || '[]') as string[], aliases: JSON.parse(r.aliases || '[]') as string[], pinned: !!r.pinned, locked: !!r.locked };
}

export type IngestRows = Omit<IndexRows, 'meta'>;

export class IndexStore {
  constructor(readonly db: D1Database) {}

  async getMeta(k: string): Promise<string | null> {
    const r = await this.db.prepare('SELECT v FROM meta WHERE k = ?').bind(k).first<{ v: string }>();
    return r?.v ?? null;
  }

  setMetaStmt(k: string, v: string): D1PreparedStatement {
    return this.db.prepare('INSERT INTO meta (k, v) VALUES (?, ?) ON CONFLICT(k) DO UPDATE SET v = excluded.v').bind(k, v);
  }

  async setMeta(k: string, v: string): Promise<void> {
    await this.setMetaStmt(k, v).run();
  }

  async config(): Promise<NitrogenConfig> {
    return parseConfig(await this.getMeta('config')).config;
  }

  /** Lightweight vault context from the index (titles, aliases, assets; no slugs). */
  async context(): Promise<VaultContext> {
    const [pages, assets, config, headings] = await Promise.all([
      this.db.prepare('SELECT path, title, aliases FROM pages').all<{ path: string; title: string; aliases: string }>(),
      this.db.prepare('SELECT path FROM assets').all<{ path: string }>(),
      this.config(),
      this.db.prepare('SELECT path, slug FROM headings').all<{ path: string; slug: string }>(),
    ]);
    const slugs = new Map<string, string[]>();
    for (const h of headings.results) (slugs.get(h.path) ?? slugs.set(h.path, []).get(h.path)!).push(h.slug);
    return {
      config,
      pages: pages.results.map((p) => ({ path: p.path, title: p.title, aliases: JSON.parse(p.aliases) as string[], slugs: slugs.get(p.path) ?? [] })),
      images: assets.results.map((a) => a.path),
    };
  }

  /** Statements that replace all rows for one page. */
  pageStatements(rows: IngestRows, lastActor: string | null = null): D1PreparedStatement[] {
    const p = rows.page;
    const s: D1PreparedStatement[] = [...this.deletePageStatements(p.path, false)];
    s.push(
      this.db
        .prepare(
          `INSERT INTO pages (path, sha, title, icon, ord, status, tags, aliases, pinned, locked, excerpt, size, updated_at, last_actor)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
           ON CONFLICT(path) DO UPDATE SET sha=excluded.sha, title=excluded.title, icon=excluded.icon, ord=excluded.ord, status=excluded.status,
             tags=excluded.tags, aliases=excluded.aliases, pinned=excluded.pinned, locked=excluded.locked, excerpt=excluded.excerpt,
             size=excluded.size, updated_at=excluded.updated_at, last_actor=COALESCE(excluded.last_actor, pages.last_actor)`,
        )
        .bind(p.path, p.sha, p.title, p.icon, p.ord, p.status, JSON.stringify(p.tags), JSON.stringify(p.aliases), p.pinned ? 1 : 0, p.locked ? 1 : 0, p.excerpt, p.size, p.updated, lastActor),
    );
    for (const l of rows.links)
      s.push(this.db.prepare('INSERT INTO links (src, dst, frag, rel, text, ctx, line) VALUES (?, ?, ?, ?, ?, ?, ?)').bind(l.src, l.dst, l.frag, l.rel, l.text, l.ctx, l.line));
    for (const i of rows.images) s.push(this.db.prepare('INSERT INTO images (src, path) VALUES (?, ?)').bind(i.src, i.path));
    for (const h of rows.headings) s.push(this.db.prepare('INSERT INTO headings (path, slug, text, level) VALUES (?, ?, ?, ?)').bind(h.path, h.slug, h.text, h.level));
    s.push(
      this.db
        .prepare('INSERT INTO pages_fts (path, title, headings, body, tags) VALUES (?, ?, ?, ?, ?)')
        .bind(p.path, p.title, rows.headings.map((h) => h.text).join('\n'), p.body, [...p.tags, ...p.aliases].join(' ')),
    );
    return s;
  }

  deletePageStatements(path: string, includePage = true): D1PreparedStatement[] {
    const s = [
      this.db.prepare('DELETE FROM links WHERE src = ?').bind(path),
      this.db.prepare('DELETE FROM images WHERE src = ?').bind(path),
      this.db.prepare('DELETE FROM headings WHERE path = ?').bind(path),
      this.db.prepare('DELETE FROM pages_fts WHERE path = ?').bind(path),
    ];
    if (includePage) s.push(this.db.prepare('DELETE FROM pages WHERE path = ?').bind(path));
    return s;
  }

  /** Index one page from source with the light scanner. */
  rowsFor(path: string, src: string, sha: string, ctx: VaultContext | null): IngestRows {
    const { meta: _m, ...rest } = indexRowsFromScan(path, src, sha, scanPage(src), ctx);
    return rest;
  }

  /** Run statements in D1 batches (each batch is a transaction). */
  async run(stmts: D1PreparedStatement[], chunk = 90): Promise<void> {
    for (let i = 0; i < stmts.length; i += chunk) await this.db.batch(stmts.slice(i, i + chunk));
  }

  async pageShas(): Promise<Map<string, string>> {
    const r = await this.db.prepare('SELECT path, sha FROM pages').all<{ path: string; sha: string }>();
    return new Map(r.results.map((x) => [x.path, x.sha]));
  }

  async getPage(path: string): Promise<PageRecord | null> {
    const r = await this.db.prepare('SELECT * FROM pages WHERE path = ?').bind(path).first<PageRowDb>();
    return r ? toRecord(r) : null;
  }

  async allPages(): Promise<PageRecord[]> {
    const r = await this.db.prepare('SELECT * FROM pages ORDER BY path').all<PageRowDb>();
    return r.results.map(toRecord);
  }

  activityStmt(a: { sha: string; actor: string; client?: string | null; tool?: string | null; op: string; path: string | null; message: string; files: number; at: string }): D1PreparedStatement {
    return this.db
      .prepare('INSERT INTO activity (sha, actor, client, tool, op, path, message, files, at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)')
      .bind(a.sha, a.actor, a.client ?? null, a.tool ?? null, a.op, a.path, a.message, a.files, a.at);
  }
}
