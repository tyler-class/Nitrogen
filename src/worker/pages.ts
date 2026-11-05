// Page storage: the tree, edits with optimistic concurrency, history, links and deletion.
import type { z } from 'zod';
import { extractFileKeys, extractLinks } from '@shared/markdown';
import {
  MAX_BULK_PAGES,
  type createPageInput,
  type createTreeInput,
  type movePageInput,
  type PageTreeInput,
  type updatePageInput,
} from '@shared/schemas';
import type { Page, PageDetail, PageSummary, Revision, RevisionDetail } from '@shared/types';
import { all, chunks, first, marks, newId, nowIso } from './db';
import { ApiError, notFound } from './routes/util';

/** Edits within this window update the page without taking a new history snapshot. */
export const REVISION_WINDOW_MS = 10 * 60_000;
export const MAX_REVISIONS = 100;

const SUMMARY_COLS = 'id, parent_id, position, title, icon, updated_at';
const PAGE_COLS = `${SUMMARY_COLS}, body, version, created_at`;

export function listSummaries(db: D1Database): Promise<PageSummary[]> {
  return all<PageSummary>(
    db,
    `SELECT ${SUMMARY_COLS} FROM pages ORDER BY parent_id, position, title`,
  );
}

export function getPage(db: D1Database, id: string): Promise<Page | null> {
  return first<Page>(db, `SELECT ${PAGE_COLS} FROM pages WHERE id = ?`, id);
}

export async function requirePage(db: D1Database, id: string): Promise<Page> {
  const page = await getPage(db, id);
  if (!page) throw notFound('Page');
  return page;
}

/** The page plus everything a page view needs, in one round trip. */
export async function getDetail(db: D1Database, id: string): Promise<PageDetail> {
  const [pageRes, ancRes, childRes, backRes] = await db.batch([
    db.prepare(`SELECT ${PAGE_COLS} FROM pages WHERE id = ?`).bind(id),
    db
      .prepare(
        `WITH RECURSIVE up (id, depth) AS (
           SELECT parent_id, 1 FROM pages WHERE id = ?1
           UNION ALL SELECT p.parent_id, up.depth + 1 FROM pages p JOIN up ON p.id = up.id
           WHERE up.depth < 64
         )
         SELECT ${SUMMARY_COLS.split(', ')
           .map((c) => `p.${c}`)
           .join(', ')} FROM up JOIN pages p ON p.id = up.id ORDER BY up.depth DESC`,
      )
      .bind(id),
    db
      .prepare(`SELECT ${SUMMARY_COLS} FROM pages WHERE parent_id = ? ORDER BY position, title`)
      .bind(id),
    db
      .prepare(
        `SELECT ${SUMMARY_COLS.split(', ')
          .map((c) => `p.${c}`)
          .join(', ')} FROM links l JOIN pages p ON p.id = l.src
         WHERE l.dst = ? AND l.src != l.dst ORDER BY p.title`,
      )
      .bind(id),
  ]);
  const page = pageRes!.results[0] as Page | undefined;
  if (!page) throw notFound('Page');
  return {
    page,
    ancestors: ancRes!.results as unknown as PageSummary[],
    children: childRes!.results as unknown as PageSummary[],
    backlinks: backRes!.results as unknown as PageSummary[],
  };
}

async function requireParent(db: D1Database, parentId: string | null): Promise<void> {
  if (parentId && !(await first(db, 'SELECT 1 FROM pages WHERE id = ?', parentId)))
    throw new ApiError(400, 'invalid', 'The parent page does not exist.');
}

/** Ids of the page and everything under it. */
export async function subtreeIds(db: D1Database, id: string): Promise<string[]> {
  const rows = await all<{ id: string }>(
    db,
    `WITH RECURSIVE down (id) AS (
       SELECT ?1 UNION SELECT p.id FROM pages p JOIN down ON p.parent_id = down.id
     ) SELECT id FROM down`,
    id,
  );
  return rows.map((r) => r.id);
}

/** Statements that renumber `ids` to positions 0..n-1 in that order. */
function renumber(db: D1Database, ids: string[]): D1PreparedStatement[] {
  return ids.map((id, i) => db.prepare('UPDATE pages SET position = ? WHERE id = ?').bind(i, id));
}

async function siblingIds(db: D1Database, parentId: string | null, except?: string) {
  const rows = await all<{ id: string }>(
    db,
    `SELECT id FROM pages WHERE parent_id IS ? AND id IS NOT ? ORDER BY position, title`,
    parentId,
    except ?? null,
  );
  return rows.map((r) => r.id);
}

/** Replace a page's outgoing links with those in `body`. */
async function linkStatements(db: D1Database, id: string, body: string) {
  const { titles, ids } = extractLinks(body);
  const targets = new Set<string>();
  for (const part of chunks(titles)) {
    const rows = await all<{ id: string }>(
      db,
      // Duplicate titles link to the oldest page (SQLite returns the row that holds the MIN).
      `SELECT id, MIN(created_at) FROM pages WHERE lower(title) IN (${marks(part.length)}) GROUP BY lower(title)`,
      ...part,
    );
    rows.forEach((r) => targets.add(r.id));
  }
  for (const part of chunks(ids)) {
    const rows = await all<{ id: string }>(
      db,
      `SELECT id FROM pages WHERE id IN (${marks(part.length)})`,
      ...part,
    );
    rows.forEach((r) => targets.add(r.id));
  }
  targets.delete(id);
  return [
    db.prepare('DELETE FROM links WHERE src = ?').bind(id),
    ...[...targets].map((dst) =>
      db.prepare('INSERT OR IGNORE INTO links (src, dst) VALUES (?, ?)').bind(id, dst),
    ),
  ];
}

/** Claim images referenced by this page that are not yet attached to any page. */
function claimFiles(db: D1Database, id: string, body: string): D1PreparedStatement[] {
  return chunks(extractFileKeys(body)).map((keys) =>
    db
      .prepare(
        `UPDATE files SET page_id = ? WHERE page_id IS NULL AND key IN (${marks(keys.length)})`,
      )
      .bind(id, ...keys),
  );
}

export async function createPage(
  db: D1Database,
  input: z.output<typeof createPageInput>,
): Promise<Page> {
  await requireParent(db, input.parent_id);
  const id = newId();
  const now = nowIso();
  const siblings = await siblingIds(db, input.parent_id);
  const at = Math.min(input.position ?? siblings.length, siblings.length);
  siblings.splice(at, 0, id);
  await db.batch([
    db
      .prepare(
        `INSERT INTO pages (id, parent_id, position, title, icon, body, version, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, 1, ?, ?)`,
      )
      .bind(id, input.parent_id, at, input.title, input.icon ?? null, input.body, now, now),
    ...renumber(db, siblings),
    ...(await linkStatements(db, id, input.body)),
    ...claimFiles(db, id, input.body),
  ]);
  return (await getPage(db, id))!;
}

export class ConflictError extends ApiError {
  constructor(public current: Page) {
    super(
      409,
      'conflict',
      `This page changed since you opened it (now version ${current.version}). Reload it, then apply your change again.`,
      { current },
    );
  }
}

export async function updatePage(
  db: D1Database,
  id: string,
  input: z.output<typeof updatePageInput>,
  opts: { snapshot?: boolean } = {},
): Promise<Page> {
  const cur = await requirePage(db, id);
  if (input.base_version !== undefined && input.base_version !== cur.version)
    throw new ConflictError(cur);

  const title = input.title ?? cur.title;
  const body = input.body ?? cur.body;
  const icon = input.icon === undefined ? cur.icon : input.icon;
  if (title === cur.title && body === cur.body && icon === cur.icon) return cur;

  const stmts: D1PreparedStatement[] = [];
  const contentChanged = title !== cur.title || body !== cur.body;
  // Snapshot the version being replaced when an edit session starts (autosave keeps writing within
  // the window), and always when asked (assistant edits, so every one of them can be undone).
  const sessionStart = Date.now() - Date.parse(cur.updated_at) > REVISION_WINDOW_MS;
  if (contentChanged && (sessionStart || opts.snapshot)) {
    {
      stmts.push(
        db
          .prepare(
            'INSERT INTO page_revisions (page_id, version, title, body, created_at) VALUES (?, ?, ?, ?, ?)',
          )
          .bind(id, cur.version, cur.title, cur.body, nowIso()),
        db
          .prepare(
            `DELETE FROM page_revisions WHERE page_id = ?1 AND id NOT IN
             (SELECT id FROM page_revisions WHERE page_id = ?1 ORDER BY id DESC LIMIT ${MAX_REVISIONS})`,
          )
          .bind(id),
      );
    }
  }
  // The WHERE on version makes the write a compare-and-swap with concurrent editors.
  const update = db
    .prepare(
      `UPDATE pages SET title = ?, icon = ?, body = ?, version = version + 1, updated_at = ?
       WHERE id = ? AND version = ?`,
    )
    .bind(title, icon, body, nowIso(), id, cur.version);
  if (body !== cur.body)
    stmts.push(...(await linkStatements(db, id, body)), ...claimFiles(db, id, body));

  const results = await db.batch([update, ...stmts]);
  if (!results[0]!.meta.changes) throw new ConflictError((await getPage(db, id)) ?? cur);
  return (await getPage(db, id))!;
}

export async function movePage(
  db: D1Database,
  id: string,
  input: z.output<typeof movePageInput>,
): Promise<Page> {
  const cur = await requirePage(db, id);
  await requireParent(db, input.parent_id);
  if (input.parent_id && (await subtreeIds(db, id)).includes(input.parent_id))
    throw new ApiError(400, 'invalid', 'A page cannot move inside itself.');

  const siblings = await siblingIds(db, input.parent_id, id);
  const at = Math.min(input.position ?? siblings.length, siblings.length);
  siblings.splice(at, 0, id);
  await db.batch([
    // Moving changes the page's place in the tree, which semantic search uses as context.
    db
      .prepare('UPDATE pages SET parent_id = ?, indexed_version = 0 WHERE id = ?')
      .bind(input.parent_id, id),
    ...renumber(db, siblings),
  ]);
  return { ...cur, parent_id: input.parent_id, position: at };
}

export interface DeleteResult {
  deleted: string[];
  /** AI Search items to remove. */
  searchItems: string[];
  /** R2 keys no longer referenced by any page. */
  orphanFiles: string[];
}

export async function deletePage(db: D1Database, id: string): Promise<DeleteResult> {
  await requirePage(db, id);
  const ids = await subtreeIds(db, id);
  const searchItems: string[] = [];
  const fileKeys: string[] = [];
  for (const part of chunks(ids)) {
    const rows = await all<{ search_item_id: string | null }>(
      db,
      `SELECT search_item_id FROM pages WHERE id IN (${marks(part.length)})`,
      ...part,
    );
    rows.forEach((r) => r.search_item_id && searchItems.push(r.search_item_id));
    const files = await all<{ key: string }>(
      db,
      `SELECT key FROM files WHERE page_id IN (${marks(part.length)})`,
      ...part,
    );
    files.forEach((f) => fileKeys.push(f.key));
  }

  // Children first, so the self-referencing foreign key never sees a dangling parent.
  const stmts = chunks([...ids].reverse()).map((part) =>
    db.prepare(`DELETE FROM pages WHERE id IN (${marks(part.length)})`).bind(...part),
  );
  const now = nowIso();
  stmts.push(
    ...searchItems.map((item) =>
      db
        .prepare('INSERT OR IGNORE INTO search_tombstones (item_id, created_at) VALUES (?, ?)')
        .bind(item, now),
    ),
  );
  await db.batch(stmts);

  // Images can be pasted into other pages; only remove those nothing references any more.
  const orphanFiles: string[] = [];
  for (const key of fileKeys) {
    const used = await first(
      db,
      'SELECT 1 FROM pages WHERE instr(body, ?) > 0 LIMIT 1',
      `/files/${key}`,
    );
    if (!used) orphanFiles.push(key);
  }
  for (const part of chunks(orphanFiles))
    await db
      .prepare(`DELETE FROM files WHERE key IN (${marks(part.length)})`)
      .bind(...part)
      .run();
  return { deleted: ids, searchItems, orphanFiles };
}

export function listRevisions(db: D1Database, id: string): Promise<Revision[]> {
  return all<Revision>(
    db,
    'SELECT id, version, title, created_at FROM page_revisions WHERE page_id = ? ORDER BY id DESC',
    id,
  );
}

export async function getRevision(
  db: D1Database,
  id: string,
  rev: number,
): Promise<RevisionDetail> {
  const row = await first<RevisionDetail>(
    db,
    'SELECT id, version, title, body, created_at FROM page_revisions WHERE page_id = ? AND id = ?',
    id,
    rev,
  );
  if (!row) throw notFound('Revision');
  return row;
}

/** Restores an old version as a new edit, so the current text stays in history. */
export async function restoreRevision(db: D1Database, id: string, rev: number): Promise<Page> {
  const old = await getRevision(db, id, rev);
  const cur = await requirePage(db, id);
  return updatePage(
    db,
    id,
    { title: old.title, body: old.body, base_version: cur.version },
    { snapshot: true },
  );
}

/** Resolve a page by id or (case-insensitive) title, for assistants. */
export async function findPage(db: D1Database, key: string): Promise<Page> {
  const k = key.trim();
  const byId = await getPage(db, k);
  if (byId) return byId;
  const byTitle = await all<Page>(
    db,
    `SELECT ${PAGE_COLS} FROM pages WHERE lower(title) = lower(?) ORDER BY created_at LIMIT 5`,
    k,
  );
  if (byTitle.length === 1) return byTitle[0]!;
  if (byTitle.length > 1)
    throw new ApiError(
      409,
      'ambiguous',
      `Several pages are titled “${k}”: ${byTitle.map((p) => p.id).join(', ')}. Use an id.`,
    );
  throw new ApiError(404, 'not_found', `No page has the id or title “${k}”.`);
}

/** Creates a whole subtree in one batch (D1's free plan allows 50 queries per request). */
export async function createTree(
  db: D1Database,
  input: z.output<typeof createTreeInput>,
): Promise<{ id: string; title: string; parent_id: string | null }[]> {
  await requireParent(db, input.parent_id);
  type Flat = { id: string; parent_id: string | null; position: number; node: PageTreeInput };
  const flat: Flat[] = [];
  const walk = (nodes: PageTreeInput[], parent: string | null, depth: number) => {
    if (depth > 12) throw new ApiError(400, 'invalid', 'Pages can nest 12 levels deep at most.');
    nodes.forEach((node, i) => {
      const id = newId();
      flat.push({ id, parent_id: parent, position: i, node });
      walk(node.children ?? [], id, depth + 1);
    });
  };
  walk(input.pages, input.parent_id, 0);
  if (flat.length > MAX_BULK_PAGES)
    throw new ApiError(400, 'invalid', `Create at most ${MAX_BULK_PAGES} pages at a time.`);

  // Top-level pages go into the existing siblings at `position`.
  const siblings = await siblingIds(db, input.parent_id);
  const at = Math.min(input.position ?? siblings.length, siblings.length);
  const tops = flat.filter((f) => f.parent_id === input.parent_id).map((f) => f.id);
  siblings.splice(at, 0, ...tops);

  // Links resolve against existing pages first (oldest wins), then the new ones.
  const byTitle = new Map<string, string>();
  const wanted = [...new Set(flat.flatMap((f) => extractLinks(f.node.body ?? '').titles))];
  for (const part of chunks(wanted)) {
    const rows = await all<{ id: string; t: string }>(
      db,
      `SELECT id, lower(title) AS t, MIN(created_at) FROM pages WHERE lower(title) IN (${marks(part.length)}) GROUP BY lower(title)`,
      ...part,
    );
    rows.forEach((r) => byTitle.set(r.t, r.id));
  }
  for (const f of flat)
    if (!byTitle.has(f.node.title.toLowerCase())) byTitle.set(f.node.title.toLowerCase(), f.id);
  const newIds = new Set(flat.map((f) => f.id));

  const now = nowIso();
  const stmts: D1PreparedStatement[] = flat.map((f) =>
    db
      .prepare(
        `INSERT INTO pages (id, parent_id, position, title, icon, body, version, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, 1, ?, ?)`,
      )
      .bind(
        f.id,
        f.parent_id,
        f.position,
        f.node.title,
        f.node.icon ?? null,
        f.node.body ?? '',
        now,
        now,
      ),
  );
  stmts.push(...renumber(db, siblings));
  for (const f of flat) {
    const { titles, ids } = extractLinks(f.node.body ?? '');
    const dsts = new Set([
      ...titles.map((t) => byTitle.get(t)).filter((x): x is string => !!x),
      ...ids.filter((id) => newIds.has(id)),
    ]);
    dsts.delete(f.id);
    for (const d of dsts)
      stmts.push(db.prepare('INSERT OR IGNORE INTO links (src, dst) VALUES (?, ?)').bind(f.id, d));
    stmts.push(...claimFiles(db, f.id, f.node.body ?? ''));
  }
  await db.batch(stmts);
  return flat.map((f) => ({ id: f.id, title: f.node.title, parent_id: f.parent_id }));
}
