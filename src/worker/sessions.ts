// Sessions: a protected system section with one entry per assistant session.
//
// Every write an assistant makes through MCP extends its current entry (a new entry starts after
// an hour without writes), so the record is complete without the assistant having to remember to
// log anything. log_session adds a title and summary to that same entry. Entries list the pages
// touched in that session only, are regenerated from the activity log, and can't be edited by
// anyone; the owner can purge one (DELETE /api/sessions/:id).
import { encodeActor, type Actor } from '@shared/actor';
import { extractItems } from '@shared/items';
import { wordCount } from '@shared/markdown';
import { all, first, nowIso, setSettingStmt } from './db';
import { createPage, itemStatements, linkStatements, sessionsRoot } from './pages';

export const SESSION_GAP_MS = 60 * 60_000;

const ROOT_BODY = `Assistants record what they do here automatically: every session that changes the wiki gets an entry listing the pages it touched, with the assistant's own summary when it adds one.

Entries are read-only. To remove a bad one, open it and choose **Purge entry**.`;

/** The Sessions page, created (and registered as the system section) if it doesn't exist. */
export async function ensureSessionsRoot(db: D1Database): Promise<string> {
  const existing = await sessionsRoot(db);
  if (existing) return existing;
  // Adopt a top-level page already called Sessions (older versions created one on demand).
  const old = await first<{ id: string }>(
    db,
    "SELECT id FROM pages WHERE parent_id IS NULL AND lower(title) = 'sessions' ORDER BY created_at LIMIT 1",
  );
  const id =
    old?.id ??
    (
      await createPage(
        db,
        { title: 'Sessions', parent_id: null, icon: '🗂️', body: ROOT_BODY },
        { kind: 'you', name: 'You' },
        { system: true },
      )
    ).id;
  await setSettingStmt(db, 'sessions_id', id).run();
  return id;
}

interface Entry {
  page_id: string;
  actor: string;
  started_at: string;
  last_at: string;
  title: string | null;
  summary: string | null;
}

const VERBS: Record<string, string> = {
  create: 'created',
  edit: 'edited',
  move: 'moved',
  delete: 'deleted',
  restore: 'restored',
};

/** Update the entry's page from the activity log and its summary. No event, no history. */
async function render(db: D1Database, root: string, e: Entry, actor: Actor) {
  const touched = await all<{ page_id: string; title: string; actions: string; exists: number }>(
    db,
    `SELECT e.page_id, COALESCE(p.title, MAX(e.title)) AS title,
            GROUP_CONCAT(DISTINCT e.action) AS actions, (p.id IS NOT NULL) AS "exists"
     FROM page_events e LEFT JOIN pages p ON p.id = e.page_id
     WHERE e.actor = ?1 AND e.created_at >= ?2 AND e.page_id != ?3
       AND (p.parent_id IS NULL OR p.parent_id != ?3)
     GROUP BY e.page_id ORDER BY MIN(e.id)`,
    e.actor,
    e.started_at,
    root,
  );
  const list = touched.length
    ? touched
        .map(
          (t) =>
            `- ${t.exists ? `[[${t.title}]]` : `${t.title} (deleted)`} — ${t.actions
              .split(',')
              .map((a) => VERBS[a] ?? a)
              .join(', ')}`,
        )
        .join('\n')
    : '- (no page changes yet)';
  const summary = e.summary?.trim() || `_${actor.name} hasn’t added a summary yet._`;
  const body = `${summary}\n\n## Pages touched\n\n${list}\n\n_Recorded automatically for ${actor.name}, ${e.started_at.slice(11, 16)}–${e.last_at.slice(11, 16)} UTC._`;
  const title = `${e.started_at.slice(0, 10)} · ${e.title?.trim() || `${actor.name} session`}`;
  await db.batch([
    db
      .prepare(
        `UPDATE pages SET title = ?, body = ?, words = ?, version = version + 1, updated_at = ?,
           updated_by = ? WHERE id = ?`,
      )
      .bind(title, body, wordCount(body), nowIso(), encodeActor(actor), e.page_id),
    ...(await linkStatements(db, e.page_id, body)),
    ...itemStatements(db, e.page_id, body),
  ]);
}

/** The actor's current entry, or a new one if their last write was over an hour ago. */
async function currentEntry(db: D1Database, root: string, actor: Actor): Promise<Entry> {
  const who = encodeActor(actor);
  const now = nowIso();
  const last = await first<Entry>(
    db,
    'SELECT * FROM session_entries WHERE actor = ? ORDER BY last_at DESC LIMIT 1',
    who,
  );
  if (last && Date.now() - Date.parse(last.last_at) < SESSION_GAP_MS) {
    await db
      .prepare('UPDATE session_entries SET last_at = ? WHERE page_id = ?')
      .bind(now, last.page_id)
      .run();
    return { ...last, last_at: now };
  }
  // Newest first under Sessions.
  const page = await createPage(
    db,
    {
      title: `${now.slice(0, 10)} · ${actor.name} session`,
      parent_id: root,
      body: '',
      tags: ['session-log'],
      position: 0,
    },
    actor,
    { system: true },
  );
  const entry: Entry = {
    page_id: page.id,
    actor: who,
    started_at: now,
    last_at: now,
    title: null,
    summary: null,
  };
  await db
    .prepare(
      'INSERT INTO session_entries (page_id, actor, started_at, last_at) VALUES (?, ?, ?, ?)',
    )
    .bind(entry.page_id, who, now, now)
    .run();
  return entry;
}

/** Record that an assistant changed the wiki (called after every successful MCP write). */
export async function touchSession(db: D1Database, actor: Actor): Promise<void> {
  if (actor.kind !== 'agent') return;
  const root = await ensureSessionsRoot(db);
  await render(db, root, await currentEntry(db, root, actor), actor);
}

/** log_session: title and summary for the assistant's current session entry. */
export async function logSession(
  db: D1Database,
  actor: Actor,
  title: string,
  summary: string,
): Promise<{ id: string; title: string; open_items: number }> {
  const root = await ensureSessionsRoot(db);
  const e = await currentEntry(db, root, actor);
  await db
    .prepare('UPDATE session_entries SET title = ?, summary = ? WHERE page_id = ?')
    .bind(title.trim().slice(0, 120), summary.trim(), e.page_id)
    .run();
  const next = { ...e, title: title.trim().slice(0, 120), summary: summary.trim() };
  await render(db, root, next, actor);
  const page = await first<{ id: string; title: string }>(
    db,
    'SELECT id, title FROM pages WHERE id = ?',
    e.page_id,
  );
  return {
    id: page!.id,
    title: page!.title,
    open_items: extractItems(summary).filter((i) => !i.done).length,
  };
}

/** Typed items were added in v0.7; index existing pages once. */
export async function ensureItemsIndexed(db: D1Database): Promise<void> {
  if (await first(db, "SELECT 1 FROM settings WHERE key = 'items_indexed'")) return;
  const pages = await all<{ id: string; body: string }>(db, 'SELECT id, body FROM pages');
  for (let i = 0; i < pages.length; i += 20)
    await db.batch(pages.slice(i, i + 20).flatMap((p) => itemStatements(db, p.id, p.body)));
  await setSettingStmt(db, 'items_indexed', '1').run();
}
