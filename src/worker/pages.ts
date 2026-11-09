// Page storage: the tree, edits with optimistic concurrency, history, links and deletion.
import type { z } from 'zod';
import { encodeActor, type Actor } from '@shared/actor';
import { extractItems } from '@shared/items';
import { extractFileKeys, extractLinks, extractTags, wordCount } from '@shared/markdown';
import {
  MAX_BULK_PAGES,
  type createPageInput,
  type createTreeInput,
  type movePageInput,
  type PageTreeInput,
  type updatePageInput,
} from '@shared/schemas';
import type {
  EventAction,
  Page,
  PageDetail,
  PageSummary,
  Revision,
  RevisionDetail,
} from '@shared/types';
import { all, chunks, first, marks, newId, nowIso } from './db';
import { ApiError, notFound } from './routes/util';

/** Edits within this window update the page without taking a new history snapshot. */
export const REVISION_WINDOW_MS = 10 * 60_000;
export const MAX_REVISIONS = 100;

export const SUMMARY_COLS =
  'id, parent_id, position, title, icon, updated_at, updated_by, pinned_at';
const PAGE_COLS = `${SUMMARY_COLS}, body, version, created_at, created_by, tags, words`;
/** SUMMARY_COLS prefixed with a table alias. */
export const summaryCols = (alias: string) =>
  SUMMARY_COLS.split(', ')
    .map((c) => `${alias}.${c}`)
    .join(', ');

type PageRow = Omit<Page, 'tags'> & { tags: string | string[] };

/** Rows store tags as JSON text. */
export function hydrate(row: PageRow): Page {
  if (Array.isArray(row.tags)) return row as Page;
  let tags: string[] = [];
  try {
    const v: unknown = JSON.parse(row.tags || '[]');
    if (Array.isArray(v)) tags = v.filter((t): t is string => typeof t === 'string');
  } catch {
    /* malformed: no tags */
  }
  return { ...row, tags };
}

export function listSummaries(db: D1Database): Promise<PageSummary[]> {
  return all<PageSummary>(
    db,
    `SELECT ${SUMMARY_COLS} FROM pages ORDER BY parent_id, position, title`,
  );
}

export async function getPage(db: D1Database, id: string): Promise<Page | null> {
  const row = await first<PageRow>(db, `SELECT ${PAGE_COLS} FROM pages WHERE id = ?`, id);
  return row ? hydrate(row) : null;
}

export async function requirePage(db: D1Database, id: string): Promise<Page> {
  const page = await getPage(db, id);
  if (!page) throw notFound('Page');
  return page;
}

/** The page plus everything a page view needs, in one round trip. */
export async function getDetail(db: D1Database, id: string): Promise<PageDetail> {
  const [pageRes, ancRes, childRes, backRes, tagRes] = await db.batch([
    db.prepare(`SELECT ${PAGE_COLS} FROM pages WHERE id = ?`).bind(id),
    db
      .prepare(
        `WITH RECURSIVE up (id, depth) AS (
           SELECT parent_id, 1 FROM pages WHERE id = ?1
           UNION ALL SELECT p.parent_id, up.depth + 1 FROM pages p JOIN up ON p.id = up.id
           WHERE up.depth < 64
         )
         SELECT ${summaryCols('p')} FROM up JOIN pages p ON p.id = up.id ORDER BY up.depth DESC`,
      )
      .bind(id),
    db
      .prepare(`SELECT ${SUMMARY_COLS} FROM pages WHERE parent_id = ? ORDER BY position, title`)
      .bind(id),
    db
      .prepare(
        `SELECT ${summaryCols('p')} FROM links l JOIN pages p ON p.id = l.src
         WHERE l.dst = ? AND l.src != l.dst ORDER BY p.title`,
      )
      .bind(id),
    db.prepare('SELECT tag FROM page_tags WHERE page_id = ? ORDER BY tag').bind(id),
  ]);
  const row = pageRes!.results[0] as PageRow | undefined;
  if (!row) throw notFound('Page');
  return {
    page: hydrate(row),
    all_tags: (tagRes!.results as { tag: string }[]).map((t) => t.tag),
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
export async function linkStatements(db: D1Database, id: string, body: string) {
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

/** Replace a page's tag index with its own tags plus #tags in the body. */
/** Replace a page's typed-item index with the markers in `body`. */
export function itemStatements(db: D1Database, id: string, body: string) {
  return [
    db.prepare('DELETE FROM page_items WHERE page_id = ?').bind(id),
    ...extractItems(body).map((i) =>
      db
        .prepare(
          'INSERT OR REPLACE INTO page_items (page_id, line, type, text, owner, due, done, answer) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
        )
        .bind(id, i.line, i.type, i.text, i.owner, i.due, i.done ? 1 : 0, i.answer),
    ),
  ];
}

// ---------------------------------------------------------------- protected Sessions

/** The system Sessions page, or null if there isn't one yet. */
export async function sessionsRoot(db: D1Database): Promise<string | null> {
  const row = await first<{ id: string }>(
    db,
    "SELECT p.id FROM settings s JOIN pages p ON p.id = s.value WHERE s.key = 'sessions_id'",
  );
  return row?.id ?? null;
}

/** 'root' for the Sessions page, 'entry' for anything inside it, else null. */
export async function protection(
  db: D1Database,
  id: string | null,
): Promise<'root' | 'entry' | null> {
  if (!id) return null;
  const root = await sessionsRoot(db);
  if (!root) return null;
  if (id === root) return 'root';
  const hit = await first(
    db,
    `WITH RECURSIVE up (id, depth) AS (
       SELECT parent_id, 1 FROM pages WHERE id = ?1
       UNION ALL SELECT p.parent_id, up.depth + 1 FROM pages p JOIN up ON p.id = up.id WHERE up.depth < 64
     ) SELECT 1 FROM up WHERE id = ?2 LIMIT 1`,
    id,
    root,
  );
  return hit ? 'entry' : null;
}

export const protectedError = (what: 'root' | 'entry') =>
  new ApiError(
    403,
    'protected',
    what === 'root'
      ? 'Sessions is a system section: it can’t be edited, renamed, moved or deleted.'
      : 'Session entries are written automatically from what assistants do and can’t be changed. Assistants add a title and summary to their own session with log_session.',
  );

function tagStatements(db: D1Database, id: string, own: string[], body: string) {
  const all = [...new Set([...own, ...extractTags(body)])];
  return [
    db.prepare('DELETE FROM page_tags WHERE page_id = ?').bind(id),
    ...all.map((t) =>
      db.prepare('INSERT OR IGNORE INTO page_tags (page_id, tag) VALUES (?, ?)').bind(id, t),
    ),
  ];
}

/** Edits by the same actor closer together than this are one event in the activity log. */
export const EVENT_MERGE_MS = REVISION_WINDOW_MS;

/** Log an event, merging it into the page's last one when it continues the same burst. */
async function eventStatements(
  db: D1Database,
  e: { page_id: string; title: string; action: EventAction; actor: Actor; words: number | null },
): Promise<D1PreparedStatement[]> {
  const actor = encodeActor(e.actor);
  const now = nowIso();
  if (e.action === 'edit') {
    const last = await first<{
      id: number;
      action: string;
      actor: string | null;
      created_at: string;
    }>(
      db,
      'SELECT id, action, actor, created_at FROM page_events WHERE page_id = ? ORDER BY id DESC LIMIT 1',
      e.page_id,
    );
    if (
      last &&
      last.actor === actor &&
      (last.action === 'edit' || last.action === 'create') &&
      Date.now() - Date.parse(last.created_at) < EVENT_MERGE_MS
    )
      return [
        db
          .prepare(
            `UPDATE page_events SET title = ?, words = ?,
               created_at = CASE WHEN action = 'create' THEN created_at ELSE ? END WHERE id = ?`,
          )
          .bind(e.title, e.words, now, last.id),
      ];
  }
  return [
    db
      .prepare(
        'INSERT INTO page_events (page_id, title, action, actor, words, started_at, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
      )
      .bind(e.page_id, e.title, e.action, actor, e.words, now, now),
  ];
}

export async function createPage(
  db: D1Database,
  input: z.output<typeof createPageInput>,
  actor: Actor,
  opts: { system?: boolean } = {},
): Promise<Page> {
  await requireParent(db, input.parent_id);
  if (!opts.system && (await protection(db, input.parent_id))) throw protectedError('entry');
  const id = newId();
  const now = nowIso();
  const siblings = await siblingIds(db, input.parent_id);
  const at = Math.min(input.position ?? siblings.length, siblings.length);
  siblings.splice(at, 0, id);
  const by = encodeActor(actor);
  const tags = input.tags ?? [];
  const words = wordCount(input.body);
  await db.batch([
    db
      .prepare(
        `INSERT INTO pages (id, parent_id, position, title, icon, body, version, created_at, updated_at,
           created_by, updated_by, viewed_at, tags, words)
         VALUES (?, ?, ?, ?, ?, ?, 1, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .bind(
        id,
        input.parent_id,
        at,
        input.title,
        input.icon ?? null,
        input.body,
        now,
        now,
        by,
        by,
        actor.kind === 'you' ? now : null,
        JSON.stringify(tags),
        words,
      ),
    ...renumber(db, siblings),
    ...(await linkStatements(db, id, input.body)),
    ...claimFiles(db, id, input.body),
    ...tagStatements(db, id, tags, input.body),
    ...itemStatements(db, id, input.body),
    // System pages (Sessions entries) aren't part of the activity log they summarize.
    ...(opts.system
      ? []
      : await eventStatements(db, {
          page_id: id,
          title: input.title,
          action: 'create',
          actor,
          words,
        })),
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
  opts: { actor: Actor; snapshot?: boolean; action?: 'edit' | 'restore' },
): Promise<Page> {
  const cur = await requirePage(db, id);
  const prot = await protection(db, id);
  if (prot) throw protectedError(prot);
  if (input.base_version !== undefined && input.base_version !== cur.version)
    throw new ConflictError(cur);

  const title = input.title ?? cur.title;
  const body = input.body ?? cur.body;
  const icon = input.icon === undefined ? cur.icon : input.icon;
  const tags = input.tags ?? cur.tags;
  const tagsChanged = JSON.stringify(tags) !== JSON.stringify(cur.tags);
  if (title === cur.title && body === cur.body && icon === cur.icon && !tagsChanged) return cur;
  const by = encodeActor(opts.actor);
  const words = body === cur.body ? cur.words : wordCount(body);

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
            'INSERT INTO page_revisions (page_id, version, title, body, created_at, actor) VALUES (?, ?, ?, ?, ?, ?)',
          )
          .bind(id, cur.version, cur.title, cur.body, nowIso(), cur.updated_by),
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
      `UPDATE pages SET title = ?1, icon = ?2, body = ?3, tags = ?4, words = ?5, version = version + 1,
         updated_at = ?6, updated_by = ?7, viewed_at = CASE WHEN ?8 THEN ?6 ELSE viewed_at END
       WHERE id = ?9 AND version = ?10`,
    )
    .bind(
      title,
      icon,
      body,
      JSON.stringify(tags),
      words,
      nowIso(),
      by,
      opts.actor.kind === 'you' ? 1 : 0,
      id,
      cur.version,
    );
  if (body !== cur.body)
    stmts.push(...(await linkStatements(db, id, body)), ...claimFiles(db, id, body));
  if (body !== cur.body || tagsChanged) stmts.push(...tagStatements(db, id, tags, body));
  if (body !== cur.body) stmts.push(...itemStatements(db, id, body));
  stmts.push(
    ...(await eventStatements(db, {
      page_id: id,
      title,
      action: opts.action ?? 'edit',
      actor: opts.actor,
      words,
    })),
  );

  const results = await db.batch([update, ...stmts]);
  if (!results[0]!.meta.changes) throw new ConflictError((await getPage(db, id)) ?? cur);
  return (await getPage(db, id))!;
}

export async function movePage(
  db: D1Database,
  id: string,
  input: z.output<typeof movePageInput>,
  actor: Actor,
): Promise<Page> {
  const cur = await requirePage(db, id);
  await requireParent(db, input.parent_id);
  const prot = (await protection(db, id)) ?? (await protection(db, input.parent_id));
  if (prot) throw protectedError(prot);
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
    ...(cur.parent_id !== input.parent_id
      ? await eventStatements(db, {
          page_id: id,
          title: cur.title,
          action: 'move',
          actor,
          words: null,
        })
      : []),
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

export async function deletePage(db: D1Database, id: string, actor: Actor): Promise<DeleteResult> {
  await requirePage(db, id);
  const prot = await protection(db, id);
  // AI Sessions and its entries are permanent: nobody deletes them, not even the owner.
  if (prot) throw protectedError(prot);
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

  const now = nowIso();
  // Log first, while the titles still exist.
  const stmts = chunks(ids).map((part) =>
    db
      .prepare(
        `INSERT INTO page_events (page_id, title, action, actor, words, started_at, created_at)
         SELECT id, title, 'delete', ?, words, ?, ? FROM pages WHERE id IN (${marks(part.length)})`,
      )
      .bind(encodeActor(actor), now, now, ...part),
  );
  // Children first, so the self-referencing foreign key never sees a dangling parent.
  stmts.push(
    ...chunks([...ids].reverse()).map((part) =>
      db.prepare(`DELETE FROM pages WHERE id IN (${marks(part.length)})`).bind(...part),
    ),
  );
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
    // Kept while any page or saved version still shows it (the scheduled cleanup takes it later).
    const used = await first(
      db,
      `SELECT 1 FROM pages WHERE instr(body, ?1) > 0
       UNION ALL SELECT 1 FROM page_revisions WHERE instr(body, ?1) > 0
       LIMIT 1`,
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
    'SELECT id, version, title, created_at, actor FROM page_revisions WHERE page_id = ? ORDER BY id DESC',
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
    'SELECT id, version, title, body, created_at, actor FROM page_revisions WHERE page_id = ? AND id = ?',
    id,
    rev,
  );
  if (!row) throw notFound('Revision');
  return row;
}

/** Restores an old version as a new edit, so the current text stays in history. */
export async function restoreRevision(
  db: D1Database,
  id: string,
  rev: number,
  actor: Actor,
): Promise<Page> {
  const old = await getRevision(db, id, rev);
  const cur = await requirePage(db, id);
  return updatePage(
    db,
    id,
    { title: old.title, body: old.body, base_version: cur.version },
    { snapshot: true, actor, action: 'restore' },
  );
}

/** Resolve a page by id or (case-insensitive) title, for assistants. */
export async function findPage(db: D1Database, key: string): Promise<Page> {
  const k = key.trim();
  const byId = await getPage(db, k);
  if (byId) return byId;
  const byTitle = await all<PageRow>(
    db,
    `SELECT ${PAGE_COLS} FROM pages WHERE lower(title) = lower(?) ORDER BY created_at LIMIT 5`,
    k,
  );
  if (byTitle.length === 1) return hydrate(byTitle[0]!);
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
  actor: Actor,
): Promise<{ id: string; title: string; parent_id: string | null }[]> {
  await requireParent(db, input.parent_id);
  if (await protection(db, input.parent_id)) throw protectedError('entry');
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
  const by = encodeActor(actor);
  const stmts: D1PreparedStatement[] = flat.map((f) =>
    db
      .prepare(
        `INSERT INTO pages (id, parent_id, position, title, icon, body, version, created_at, updated_at,
           created_by, updated_by, viewed_at, tags, words)
         VALUES (?, ?, ?, ?, ?, ?, 1, ?, ?, ?, ?, ?, ?, ?)`,
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
        by,
        by,
        actor.kind === 'you' ? now : null,
        JSON.stringify(f.node.tags ?? []),
        wordCount(f.node.body ?? ''),
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
    stmts.push(...itemStatements(db, f.id, f.node.body ?? '').slice(1));
    for (const t of new Set([...(f.node.tags ?? []), ...extractTags(f.node.body ?? '')]))
      stmts.push(
        db.prepare('INSERT OR IGNORE INTO page_tags (page_id, tag) VALUES (?, ?)').bind(f.id, t),
      );
  }
  for (const part of chunks(flat.map((f) => f.id)))
    stmts.push(
      db
        .prepare(
          `INSERT INTO page_events (page_id, title, action, actor, words, started_at, created_at)
           SELECT id, title, 'create', ?, words, created_at, created_at FROM pages WHERE id IN (${marks(part.length)})`,
        )
        .bind(by, ...part),
    );
  await db.batch(stmts);
  return flat.map((f) => ({ id: f.id, title: f.node.title, parent_id: f.parent_id }));
}
