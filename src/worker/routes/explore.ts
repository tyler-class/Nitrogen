// The dashboard, inbox, activity log (with undo by session), insights, tags, and the ways pages
// connect beyond the tree: related pages, unlinked mentions and the local graph.
import { Hono } from 'hono';
import { z } from 'zod';
import { isAgent } from '@shared/actor';
import { findMentions, linkFirstMention, mentionSnippet, plainText } from '@shared/markdown';
import { revertInput } from '@shared/schemas';
import { ancestorsOf } from '@shared/tree';
import type {
  Dashboard,
  Graph,
  GraphEdge,
  GraphNode,
  InboxItem,
  Insights,
  Mention,
  PageEvent,
  PageStat,
  PageSummary,
  RelatedPage,
  RevertResult,
  Session,
  TagCount,
} from '@shared/types';
import { actorOf } from '../auth';
import { all, first, nowIso } from '../db';
import {
  ConflictError,
  deletePage,
  getPage,
  listSummaries,
  requirePage,
  restoreRevision,
  summaryCols,
  updatePage,
} from '../pages';
import { indexSoon, semanticSearch } from '../search';
import { deleteFiles } from './files';
import { ApiError, body, type AppEnv } from './util';

export const explore = new Hono<AppEnv>();

const DAY = 86_400_000;
const daysAgo = (n: number) => new Date(Date.now() - n * DAY).toISOString();

const EVENT_COLS = `e.id, e.page_id, e.title, e.action, e.actor, e.started_at, e.created_at,
  (p.id IS NOT NULL) AS "exists"`;

async function recentEvents(
  db: D1Database,
  opts: { limit: number; actor?: string; since?: string },
): Promise<PageEvent[]> {
  const where: string[] = [];
  const binds: unknown[] = [];
  if (opts.actor) {
    where.push('e.actor = ?');
    binds.push(opts.actor);
  }
  if (opts.since) {
    where.push('e.created_at >= ?');
    binds.push(opts.since);
  }
  const rows = await all<Omit<PageEvent, 'exists'> & { exists: number }>(
    db,
    `SELECT ${EVENT_COLS} FROM page_events e LEFT JOIN pages p ON p.id = e.page_id
     ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
     ORDER BY e.created_at DESC, e.id DESC LIMIT ?`,
    ...binds,
    opts.limit,
  );
  return rows.map((r) => ({ ...r, exists: !!r.exists }));
}

/** A gap longer than this between one actor's events starts a new session. */
const SESSION_GAP_MS = 60 * 60_000;

/** Newest first. Events are grouped while the actor stays the same and gaps stay short. */
export function toSessions(events: PageEvent[]): Session[] {
  const out: Session[] = [];
  for (const e of events) {
    const cur = out[out.length - 1];
    if (
      cur &&
      cur.actor === e.actor &&
      Date.parse(cur.start) - Date.parse(e.created_at) < SESSION_GAP_MS
    ) {
      cur.events.push(e);
      if (e.started_at < cur.start) cur.start = e.started_at;
    } else out.push({ actor: e.actor, start: e.started_at, end: e.created_at, events: [e] });
  }
  return out;
}

// ---------------------------------------------------------------- dashboard

explore.get('/dashboard', async (c) => {
  const db = c.env.DB;
  const week = daysAgo(7);
  const [inbox, pinned, activity, counts] = await Promise.all([
    all<Omit<InboxItem, 'is_new'> & { is_new: number }>(
      db,
      `SELECT ${summaryCols('p')}, (p.viewed_at IS NULL OR p.viewed_at < p.created_at) AS is_new
       FROM pages p WHERE p.updated_by LIKE 'agent:%'
         AND (p.viewed_at IS NULL OR p.viewed_at < p.updated_at)
       ORDER BY p.updated_at DESC LIMIT 30`,
    ),
    all<PageSummary>(
      db,
      `SELECT ${summaryCols('p')} FROM pages p WHERE p.pinned_at IS NOT NULL ORDER BY p.pinned_at`,
    ),
    recentEvents(db, { limit: 12 }),
    first<{ pages: number; words: number; tags: number; edits: number; agent_edits: number }>(
      db,
      `SELECT (SELECT COUNT(*) FROM pages) AS pages,
              (SELECT COALESCE(SUM(words), 0) FROM pages) AS words,
              (SELECT COUNT(DISTINCT tag) FROM page_tags) AS tags,
              (SELECT COUNT(*) FROM page_events WHERE created_at >= ?1) AS edits,
              (SELECT COUNT(*) FROM page_events WHERE created_at >= ?1 AND actor LIKE 'agent:%') AS agent_edits`,
      week,
    ),
  ]);
  return c.json<Dashboard>({
    stats: {
      pages: counts?.pages ?? 0,
      words: counts?.words ?? 0,
      tags: counts?.tags ?? 0,
      edits_week: counts?.edits ?? 0,
      agent_edits_week: counts?.agent_edits ?? 0,
    },
    inbox: inbox.map((p) => ({ ...p, is_new: !!p.is_new })),
    pinned,
    activity,
  });
});

/** Mark everything in the inbox as seen. */
explore.post('/inbox/clear', async (c) => {
  const res = await c.env.DB.prepare(
    `UPDATE pages SET viewed_at = ? WHERE updated_by LIKE 'agent:%'
       AND (viewed_at IS NULL OR viewed_at < updated_at)`,
  )
    .bind(nowIso())
    .run();
  return c.json({ ok: true, cleared: res.meta.changes });
});

// ---------------------------------------------------------------- activity

explore.get('/activity', async (c) => {
  const limit = Math.min(1000, Math.max(1, Number(c.req.query('limit') ?? 300) || 300));
  const events = await recentEvents(c.env.DB, {
    limit,
    actor: c.req.query('actor') || undefined,
    since: c.req.query('since') || undefined,
  });
  return c.json({ sessions: toSessions(events) });
});

/**
 * Undo what one assistant did between two times: pages it created are deleted, pages it edited go
 * back to how they were before. Pages someone else changed since are left alone and reported.
 */
explore.post('/activity/revert', async (c) => {
  const { actor, from, to } = await body(c, revertInput);
  if (!isAgent(actor)) throw new ApiError(400, 'invalid', 'Only assistant sessions can be undone.');
  const db = c.env.DB;
  const me = actorOf(c.env);
  const events = await all<{ page_id: string; title: string; action: string }>(
    db,
    `SELECT page_id, title, action FROM page_events
     WHERE actor = ? AND created_at >= ? AND started_at <= ? ORDER BY id`,
    actor,
    from,
    to,
  );
  const result: RevertResult = { restored: [], deleted: [], skipped: [] };
  const created = new Set(events.filter((e) => e.action === 'create').map((e) => e.page_id));
  const touched = [...new Set(events.map((e) => e.page_id))];
  const titleOf = new Map(events.map((e) => [e.page_id, e.title]));
  const orphanFiles: string[] = [];

  for (const id of touched) {
    const page = await getPage(db, id);
    const title = page?.title ?? titleOf.get(id) ?? id;
    if (!page) {
      if (events.some((e) => e.page_id === id && e.action === 'delete'))
        result.skipped.push({ title, reason: 'Deleted pages can’t be brought back.' });
      continue;
    }
    if (page.updated_by !== actor) {
      result.skipped.push({ title, reason: 'Changed by someone else since.' });
      continue;
    }
    if (created.has(id)) {
      const kids = await first<{ n: number }>(
        db,
        'SELECT COUNT(*) AS n FROM pages WHERE parent_id = ? AND (created_by IS NOT ? OR created_at < ?)',
        id,
        actor,
        from,
      );
      if (kids?.n) {
        result.skipped.push({
          title,
          reason: 'Has pages inside it that aren’t from this session.',
        });
        continue;
      }
      const res = await deletePage(db, id, me).catch((e: unknown) => {
        if (e instanceof ApiError && e.status === 404) return null; // removed with its parent
        throw e;
      });
      if (res) {
        result.deleted.push(title);
        orphanFiles.push(...res.orphanFiles);
      }
      continue;
    }
    // Assistant edits always snapshot first, so the oldest snapshot in the window is "before".
    const before = await first<{ id: number }>(
      db,
      'SELECT id FROM page_revisions WHERE page_id = ? AND created_at >= ? ORDER BY id LIMIT 1',
      id,
      from,
    );
    if (!before) {
      result.skipped.push({ title, reason: 'No earlier version was saved.' });
      continue;
    }
    try {
      await restoreRevision(db, id, before.id, me);
      result.restored.push(title);
    } catch (e) {
      if (!(e instanceof ConflictError)) throw e;
      result.skipped.push({ title, reason: 'It changed while undoing; try again.' });
    }
  }
  await deleteFiles(c.env, orphanFiles);
  indexSoon(c.env, c.executionCtx);
  return c.json(result);
});

// ---------------------------------------------------------------- tags

explore.get('/tags', async (c) => {
  const tags = await all<TagCount>(
    c.env.DB,
    'SELECT tag, COUNT(*) AS count FROM page_tags GROUP BY tag ORDER BY count DESC, tag',
  );
  return c.json({ tags });
});

// ---------------------------------------------------------------- connections

/** Pages that name this page in plain text but don't link to it. */
explore.get('/pages/:id/mentions', async (c) => {
  const db = c.env.DB;
  const page = await requirePage(db, c.req.param('id'));
  const title = page.title.trim();
  const words = title.match(/[\p{L}\p{N}_]+/gu) ?? [];
  if (title.length < 3 || !words.length) return c.json({ mentions: [] });
  const phrase = `"${words.join(' ')}"`;
  const rows = await all<{ id: string; title: string; icon: string | null; body: string }>(
    db,
    `SELECT p.id, p.title, p.icon, p.body FROM pages_fts f JOIN pages p ON p.id = f.page_id
     WHERE pages_fts MATCH ? AND p.id != ?
       AND p.id NOT IN (SELECT src FROM links WHERE dst = ?)
     LIMIT 60`,
    `body : ${phrase}`,
    page.id,
    page.id,
  );
  const mentions: Mention[] = rows
    .filter((r) => findMentions(r.body, title).length)
    .slice(0, 20)
    .map((r) => ({
      id: r.id,
      title: r.title,
      icon: r.icon,
      snippet: mentionSnippet(r.body, title),
    }));
  return c.json({ mentions });
});

/** Turn the first plain mention of this page in `src` into a [[link]]. */
explore.post('/pages/:id/mentions/link', async (c) => {
  const { src } = await body(c, z.object({ src: z.string().min(1) }));
  const db = c.env.DB;
  const target = await requirePage(db, c.req.param('id'));
  for (let attempt = 0; ; attempt++) {
    const from = await requirePage(db, src);
    const next = linkFirstMention(from.body, target.title);
    if (next === null) throw new ApiError(409, 'conflict', 'That mention is no longer there.');
    try {
      const page = await updatePage(
        db,
        from.id,
        { body: next, base_version: from.version },
        { actor: actorOf(c.env) },
      );
      indexSoon(c.env, c.executionCtx);
      return c.json({ ok: true, version: page.version });
    } catch (e) {
      if (e instanceof ConflictError && attempt < 2) continue;
      throw e;
    }
  }
});

/** Pages about similar things that aren't already connected (semantic search). */
explore.get('/pages/:id/related', async (c) => {
  const db = c.env.DB;
  const page = await requirePage(db, c.req.param('id'));
  const linked = new Set(
    (
      await all<{ id: string }>(
        db,
        'SELECT dst AS id FROM links WHERE src = ?1 UNION SELECT src FROM links WHERE dst = ?1',
        page.id,
      )
    ).map((r) => r.id),
  );
  const pages = await listSummaries(db);
  const byId = new Map(pages.map((p) => [p.id, p]));
  const query = `${page.title}\n${plainText(page.body).slice(0, 600)}`;
  let hits: { id: string; snippet: string }[];
  try {
    hits = await semanticSearch(c.env, query, 16);
  } catch (e) {
    return c.json({
      related: [],
      unavailable: e instanceof Error ? e.message : 'Semantic search is unavailable.',
    });
  }
  const related: RelatedPage[] = [];
  for (const h of hits) {
    const p = byId.get(h.id);
    if (!p || p.id === page.id || linked.has(p.id) || p.parent_id === page.id) continue;
    if (page.parent_id === p.id) continue;
    related.push({
      id: p.id,
      title: p.title,
      icon: p.icon,
      path: ancestorsOf(p.id, byId).map((a) => a.title),
      snippet: h.snippet,
    });
    if (related.length >= 6) break;
  }
  return c.json({ related });
});

const MAX_GRAPH_NODES = 60;

/** The page, the pages it links with, and theirs (two hops). Parent and children are included. */
explore.get('/pages/:id/graph', async (c) => {
  const db = c.env.DB;
  const center = await requirePage(db, c.req.param('id'));
  const depthWanted = Math.min(3, Math.max(1, Number(c.req.query('depth') ?? 2) || 2));
  const pages = await listSummaries(db);
  const byId = new Map(pages.map((p) => [p.id, p]));
  const links = await all<{ src: string; dst: string }>(
    db,
    'SELECT src, dst FROM links WHERE src != dst',
  );
  const adj = new Map<string, Set<string>>();
  const connect = (a: string, b: string) => {
    if (!adj.has(a)) adj.set(a, new Set());
    adj.get(a)!.add(b);
  };
  for (const l of links) {
    connect(l.src, l.dst);
    connect(l.dst, l.src);
  }
  // Tree neighbours of the centre only, so the graph isn't just the outline again.
  const treeNbrs = new Set(
    [center.parent_id, ...pages.filter((p) => p.parent_id === center.id).map((p) => p.id)].filter(
      (x): x is string => !!x,
    ),
  );

  const depth = new Map<string, number>([[center.id, 0]]);
  let frontier = [center.id];
  let truncated = false;
  for (let d = 1; d <= depthWanted && frontier.length; d++) {
    const next: string[] = [];
    for (const id of frontier) {
      const nbrs = [...(adj.get(id) ?? []), ...(id === center.id ? treeNbrs : [])];
      for (const n of nbrs) {
        if (depth.has(n) || !byId.has(n)) continue;
        if (depth.size >= MAX_GRAPH_NODES) {
          truncated = true;
          break;
        }
        depth.set(n, d);
        next.push(n);
      }
    }
    frontier = next;
  }
  const nodes: GraphNode[] = [...depth].map(([id, d]) => ({
    id,
    title: byId.get(id)?.title ?? id,
    icon: byId.get(id)?.icon ?? null,
    depth: d,
  }));
  const seen = new Set<string>();
  const edges: GraphEdge[] = [];
  for (const l of links) {
    if (!depth.has(l.src) || !depth.has(l.dst)) continue;
    const key = [l.src, l.dst].sort().join(' ');
    if (seen.has(key)) continue;
    seen.add(key);
    edges.push({ source: l.src, target: l.dst, kind: 'link' });
  }
  for (const n of treeNbrs) {
    const key = [center.id, n].sort().join(' ');
    if (!depth.has(n) || seen.has(key)) continue;
    seen.add(key);
    edges.push({ source: center.id, target: n, kind: 'tree' });
  }
  return c.json<Graph>({ center: center.id, nodes, edges, truncated });
});

// ---------------------------------------------------------------- insights

explore.get('/insights', async (c) => {
  const db = c.env.DB;
  const [days, authors, created, pages, tags, misses, home, links] = await Promise.all([
    all<{ day: string; you: number; agents: number }>(
      db,
      `SELECT substr(created_at, 1, 10) AS day,
              SUM(CASE WHEN actor LIKE 'agent:%' THEN 0 ELSE 1 END) AS you,
              SUM(CASE WHEN actor LIKE 'agent:%' THEN 1 ELSE 0 END) AS agents
       FROM page_events WHERE created_at >= ? GROUP BY day ORDER BY day`,
      daysAgo(366),
    ),
    all<{ actor: string | null; edits: number }>(
      db,
      'SELECT actor, COUNT(*) AS edits FROM page_events GROUP BY actor ORDER BY edits DESC',
    ),
    all<{ actor: string | null; created: number }>(
      db,
      'SELECT created_by AS actor, COUNT(*) AS created FROM pages GROUP BY created_by',
    ),
    all<PageStat>(
      db,
      `SELECT p.id, p.title, p.icon, p.parent_id, p.words, p.created_at, p.updated_at,
              (SELECT COUNT(*) FROM links l WHERE l.dst = p.id AND l.src != p.id) AS backlinks,
              COALESCE(e.e7, 0) AS e7, COALESCE(e.e30, 0) AS e30,
              COALESCE(e.e90, 0) AS e90, COALESCE(e.eall, 0) AS eall
       FROM pages p LEFT JOIN (
         SELECT page_id,
                SUM(created_at >= ?1) AS e7, SUM(created_at >= ?2) AS e30,
                SUM(created_at >= ?3) AS e90, COUNT(*) AS eall
         FROM page_events WHERE action IN ('create', 'edit', 'restore') GROUP BY page_id
       ) e ON e.page_id = p.id`,
      daysAgo(7),
      daysAgo(30),
      daysAgo(90),
    ),
    all<TagCount>(
      db,
      'SELECT tag, COUNT(*) AS count FROM page_tags GROUP BY tag ORDER BY count DESC, tag',
    ),
    all<{ query: string; count: number; last: string }>(
      db,
      `SELECT lower(query) AS query, COUNT(*) AS count, MAX(created_at) AS last FROM search_log
       WHERE hits = 0 AND created_at >= ? GROUP BY lower(query) ORDER BY last DESC LIMIT 20`,
      daysAgo(90),
    ),
    first<{ value: string }>(db, "SELECT value FROM settings WHERE key = 'home_id'"),
    first<{ n: number }>(db, 'SELECT COUNT(*) AS n FROM links WHERE src != dst'),
  ]);
  const createdBy = new Map(created.map((r) => [r.actor, r.created]));
  // Authors who created pages but whose edits were all merged away still show up.
  for (const r of created)
    if (!authors.some((a) => a.actor === r.actor)) authors.push({ actor: r.actor, edits: 0 });
  return c.json<Insights>({
    days,
    authors: authors.map((a) => ({ ...a, created: createdBy.get(a.actor) ?? 0 })),
    pages,
    tags,
    misses,
    home_id: home?.value ?? null,
    links: links?.n ?? 0,
  });
});

/** Ids of every page an actor touched since a time; used by the MCP session log. */
export async function pagesTouched(db: D1Database, actor: string, since: string) {
  return all<{ page_id: string; title: string; actions: string }>(
    db,
    `SELECT e.page_id, COALESCE(p.title, e.title) AS title, GROUP_CONCAT(DISTINCT e.action) AS actions
     FROM page_events e LEFT JOIN pages p ON p.id = e.page_id
     WHERE e.actor = ? AND e.created_at >= ? GROUP BY e.page_id ORDER BY MIN(e.id)`,
    actor,
    since,
  );
}
