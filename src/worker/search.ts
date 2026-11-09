// Search. Keyword search (D1 FTS5) always works, locally too. Semantic search uses AI Search
// (Cloudflare's managed hybrid vector + keyword index); the Worker creates its own instance on
// first use, so deploys need no extra setup. When AI Search is unavailable (local dev, free-plan
// query quota, not indexed yet) callers fall back to keyword results.
import { ftsQuery, plainText } from '@shared/markdown';
import { ancestorsOf } from '@shared/tree';
import type { PageSummary, SearchHit, SearchResponse } from '@shared/types';
import { all, chunks, first, nowIso } from './db';
import { listSummaries } from './pages';

const ITEM_PREFIX = 'pages/';
const itemKey = (id: string) => `${ITEM_PREFIX}${id}.md`;
const idFromKey = (key: string) =>
  key.startsWith(ITEM_PREFIX) ? key.slice(ITEM_PREFIX.length).replace(/\.md$/, '') : null;

// ---------------------------------------------------------------------------------------------
// Keyword search

export async function keywordSearch(db: D1Database, q: string, limit = 20) {
  const match = ftsQuery(q);
  if (!match) return [];
  return all<{ id: string; snippet: string; rank: number }>(
    db,
    `SELECT page_id AS id, snippet(pages_fts, 2, char(1), char(2), '…', 18) AS snippet,
            bm25(pages_fts, 0.0, 8.0, 1.0) AS rank
     FROM pages_fts WHERE pages_fts MATCH ? ORDER BY rank LIMIT ?`,
    match,
    limit,
  );
}

// ---------------------------------------------------------------------------------------------
// Semantic index (AI Search)

/** Set once the instance is known to exist. Only this flag is cached: binding handles are tied to
 * the request that created them and must not be reused across requests. */
let instanceExists = false;

function instanceName(env: Cloudflare.Env): string {
  return env.SEARCH_INSTANCE || 'nitrogen';
}

/** The instance, created with hybrid (vector + BM25) indexing if it does not exist yet. */
export async function semanticInstance(env: Cloudflare.Env): Promise<AiSearchInstance> {
  // Typed from wrangler.jsonc as "on"; dev and tests override it.
  if ((env.SEMANTIC_SEARCH as string) === 'off')
    throw new Error('Semantic search is turned off (local dev or SEMANTIC_SEARCH=off).');
  if (!env.AI_SEARCH) throw new Error('AI Search is not bound to this Worker.');
  const name = instanceName(env);
  const inst = env.AI_SEARCH.get(name);
  if (instanceExists) return inst;
  try {
    await inst.info();
  } catch {
    try {
      await env.AI_SEARCH.create({
        id: name,
        index_method: { vector: true, keyword: true },
        fusion_method: 'rrf',
      });
    } catch (e) {
      // Another request may have created it in the meantime.
      await inst.info().catch(() => {
        throw e;
      });
    }
  }
  instanceExists = true;
  return env.AI_SEARCH.get(name);
}

/** Text sent to the index: title, place in the tree, then readable body text. */
function document(page: { title: string; body: string }, path: string[]): string {
  const where = path.length ? `Location: ${path.join(' › ')}\n\n` : '';
  return `# ${page.title}\n\n${where}${plainText(page.body) || page.title}\n`;
}

/** Index pages whose stored version is ahead of their indexed version. Returns how many. */
export async function drainIndex(env: Cloudflare.Env, limit = 10): Promise<number> {
  const db = env.DB;
  const tombstones = await all<{ item_id: string }>(
    db,
    'SELECT item_id FROM search_tombstones LIMIT 50',
  );
  const due = await all<{
    id: string;
    title: string;
    body: string;
    version: number;
    search_item_id: string | null;
  }>(
    db,
    `SELECT id, title, body, version, search_item_id FROM pages
     WHERE indexed_version < version ORDER BY updated_at DESC LIMIT ?`,
    limit,
  );
  if (!tombstones.length && !due.length) return 0;

  const inst = await semanticInstance(env);
  for (const t of tombstones) {
    await inst.items.delete(t.item_id).catch(() => undefined);
    await db.prepare('DELETE FROM search_tombstones WHERE item_id = ?').bind(t.item_id).run();
  }
  if (!due.length) return 0;

  const byId = new Map((await listSummaries(db)).map((p) => [p.id, p]));
  let done = 0;
  for (const page of due) {
    const path = ancestorsOf(page.id, byId).map((p) => p.title);
    if (page.search_item_id) await inst.items.delete(page.search_item_id).catch(() => undefined);
    const item = await inst.items.upload(itemKey(page.id), document(page, path));
    // Only mark as indexed if nobody edited the page meanwhile; otherwise the next drain retries.
    await db
      .prepare(
        'UPDATE pages SET search_item_id = ?, indexed_version = ? WHERE id = ? AND version = ?',
      )
      .bind(item.id, page.version, page.id, page.version)
      .run();
    const latest = await first<{ search_item_id: string | null }>(
      db,
      'SELECT search_item_id FROM pages WHERE id = ?',
      page.id,
    );
    if (!latest) await inst.items.delete(item.id).catch(() => undefined);
    else if (latest.search_item_id !== item.id)
      await db
        .prepare('UPDATE pages SET search_item_id = ? WHERE id = ?')
        .bind(item.id, page.id)
        .run();
    done++;
  }
  return done;
}

/** Fire-and-forget indexing after a write. Failures are retried by the cron trigger. */
export function indexSoon(env: Cloudflare.Env, ctx: { waitUntil(p: Promise<unknown>): void }) {
  ctx.waitUntil(
    drainIndex(env, 5).catch((e: unknown) =>
      console.warn('semantic indexing deferred:', e instanceof Error ? e.message : e),
    ),
  );
}

/** Queue removed pages' index items; they are deleted on the next drain. */
export async function forgetItems(db: D1Database, itemIds: string[]): Promise<void> {
  const now = nowIso();
  for (const part of chunks(itemIds))
    await db.batch(
      part.map((id) =>
        db
          .prepare('INSERT OR IGNORE INTO search_tombstones (item_id, created_at) VALUES (?, ?)')
          .bind(id, now),
      ),
    );
}

export async function semanticSearch(
  env: Cloudflare.Env,
  q: string,
  limit = 20,
  opts: { retrieval?: 'hybrid' | 'vector'; threshold?: number } = {},
) {
  const inst = await semanticInstance(env);
  const res = await inst.search({
    query: q,
    ai_search_options: {
      retrieval: {
        retrieval_type: opts.retrieval ?? 'hybrid',
        max_num_results: Math.min(50, limit * 2),
        match_threshold: opts.threshold ?? 0.3,
        return_on_failure: false,
      },
    },
  });
  const best = new Map<string, { id: string; snippet: string; score: number }>();
  for (const c of res.chunks) {
    const id = idFromKey(c.item.key);
    if (!id) continue;
    const prev = best.get(id);
    if (!prev || c.score > prev.score)
      best.set(id, { id, score: c.score, snippet: c.text.replace(/\s+/g, ' ').slice(0, 240) });
  }
  return [...best.values()].sort((a, b) => b.score - a.score).slice(0, limit);
}

function unavailableMessage(e: unknown): string {
  const msg = e instanceof Error ? e.message : String(e);
  if (/quota|7069|429/i.test(msg))
    return 'The monthly AI Search query allowance is used up; showing keyword results.';
  if (/turned off|not bound|not supported|remote|local/i.test(msg))
    return 'Semantic search runs on Cloudflare only (not in local dev); showing keyword results.';
  return `Semantic search is unavailable right now (${msg.slice(0, 160)}); showing keyword results.`;
}

// ---------------------------------------------------------------------------------------------
// Combined search

/** Reciprocal rank fusion: robust to the two lists having incomparable scores. */
function fuse<T extends { id: string }>(lists: T[][], k = 60): Map<string, number> {
  const scores = new Map<string, number>();
  for (const list of lists)
    list.forEach((item, rank) =>
      scores.set(item.id, (scores.get(item.id) ?? 0) + 1 / (k + rank + 1)),
    );
  return scores;
}

export async function search(
  env: Cloudflare.Env,
  q: string,
  mode: SearchResponse['mode'],
  limit = 20,
): Promise<SearchResponse> {
  const query = q.trim();
  if (!query) return { query, mode, hits: [] };

  const wantKeyword = mode !== 'semantic';
  const wantSemantic = mode !== 'keyword';
  let semanticUnavailable: string | undefined;
  const [kw, sem] = await Promise.all([
    wantKeyword ? keywordSearch(env.DB, query, limit) : Promise.resolve([]),
    wantSemantic
      ? semanticSearch(env, query, limit).catch((e: unknown) => {
          semanticUnavailable = unavailableMessage(e);
          return null;
        })
      : Promise.resolve([]),
  ]);
  // Semantic-only requests still answer with keyword hits when AI Search can't.
  const keyword = sem === null && !wantKeyword ? await keywordSearch(env.DB, query, limit) : kw;
  const semantic = sem ?? [];

  const pages = await listSummaries(env.DB);
  const byId = new Map(pages.map((p) => [p.id, p]));
  const fused = fuse<{ id: string }>([semantic, keyword]);
  const kwSnippet = new Map(keyword.map((h) => [h.id, h.snippet]));
  const semSnippet = new Map(semantic.map((h) => [h.id, h.snippet]));

  const hits: SearchHit[] = [];
  for (const [id, score] of [...fused].sort((a, b) => b[1] - a[1])) {
    const p: PageSummary | undefined = byId.get(id);
    if (!p) continue; // deleted since it was indexed
    hits.push({
      id,
      title: p.title,
      icon: p.icon,
      // Keyword snippets carry match highlights, so prefer them.
      snippet: kwSnippet.get(id) || semSnippet.get(id) || '',
      path: ancestorsOf(id, byId).map((a) => a.title),
      score,
      source: semSnippet.has(id) ? 'semantic' : 'keyword',
    });
    if (hits.length >= limit) break;
  }
  return {
    query,
    mode,
    hits,
    ...(semanticUnavailable ? { semantic_unavailable: semanticUnavailable } : {}),
  };
}

/** Used after a restore: everything needs re-indexing and old items need deleting. */
export async function resetIndex(db: D1Database): Promise<void> {
  const rows = await all<{ search_item_id: string }>(
    db,
    'SELECT search_item_id FROM pages WHERE search_item_id IS NOT NULL',
  );
  await forgetItems(
    db,
    rows.map((r) => r.search_item_id),
  );
  await db.prepare('UPDATE pages SET indexed_version = 0, search_item_id = NULL').run();
}
