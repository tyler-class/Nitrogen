/**
 * Index freshness outside the commit pipeline: webhook pushes and tree diffs enqueue paths,
 * and `drain` indexes a bounded number per invocation (subrequest budget: 2 + N blob fetches).
 */
import { isAssetPath, isPagePath } from '@nitrogen/core/light';
import type { RepoService } from './service.ts';
import type { IndexStore } from '../db/store.ts';
import { parseTrailers, subjectOf } from './actor.ts';

export const DRAIN_BATCH = 20;
export const CONFIG_PATH = '.nitrogen/config.yml';

export interface PushPayload {
  ref: string;
  before: string;
  after: string;
  deleted?: boolean;
  commits?: { id: string; message: string; timestamp?: string; added?: string[]; removed?: string[]; modified?: string[] }[];
}

export async function enqueue(store: IndexStore, paths: Iterable<string>, head: string): Promise<number> {
  const now = new Date().toISOString();
  const stmts = [...new Set(paths)].map((p) =>
    store.db.prepare('INSERT INTO reindex_queue (path, head, enqueued_at) VALUES (?, ?, ?) ON CONFLICT(path) DO UPDATE SET head = excluded.head').bind(p, head, now),
  );
  await store.run(stmts);
  return stmts.length;
}

/** Record a push: enqueue changed paths, log external commits in activity, move head. */
export async function handlePush(store: IndexStore, branch: string, p: PushPayload): Promise<{ queued: number }> {
  if (p.ref !== `refs/heads/${branch}` || p.deleted) return { queued: 0 };
  const paths = new Set<string>();
  const stmts: D1PreparedStatement[] = [];
  const known = new Set(
    (await store.db.prepare(`SELECT sha FROM activity WHERE sha IN (${(p.commits ?? []).map(() => '?').join(',') || "''"})`).bind(...(p.commits ?? []).map((c) => c.id)).all<{ sha: string }>()).results.map((r) => r.sha),
  );
  for (const c of p.commits ?? []) {
    const files = [...(c.added ?? []), ...(c.modified ?? []), ...(c.removed ?? [])];
    files.forEach((f) => paths.add(f));
    if (!known.has(c.id)) {
      const t = parseTrailers(c.message);
      stmts.push(store.activityStmt({ sha: c.id, actor: t.actor, client: t.client ?? 'git', tool: t.tool ?? null, op: 'push', path: files[0] ?? null, message: subjectOf(c.message), files: files.length, at: c.timestamp ?? new Date().toISOString() }));
    }
  }
  stmts.push(store.setMetaStmt('head', p.after));
  await store.run(stmts);
  // A push with too many commits omits file lists; fall back to a tree diff.
  if (!p.commits || p.commits.length === 0 || p.commits.length >= 20) await store.setMeta('needs_tree_sync', p.after);
  return { queued: await enqueue(store, paths, p.after) };
}

/** Compare the repo tree at head with the index and enqueue differences. 2 subrequests. */
export async function syncFromTree(repo: RepoService, store: IndexStore, head?: string): Promise<number> {
  const h = head ?? (await repo.head());
  const tree = await repo.tree(await repo.treeShaOf(h));
  const config = await store.config();
  const indexed = await store.pageShas();
  const assets = new Map((await store.db.prepare('SELECT path, sha FROM assets').all<{ path: string; sha: string }>()).results.map((a) => [a.path, a.sha]));
  const paths: string[] = [];
  const cfg = tree.get(CONFIG_PATH);
  if (cfg && cfg.sha !== (await store.getMeta('config_sha'))) paths.push(CONFIG_PATH);
  for (const [path, item] of tree) {
    if (isPagePath(path, config) && indexed.get(path) !== item.sha) paths.push(path);
    else if (isAssetPath(path, config) && assets.get(path) !== item.sha) paths.push(path);
  }
  for (const p of indexed.keys()) if (!tree.has(p)) paths.push(p);
  for (const p of assets.keys()) if (!tree.has(p)) paths.push(p);
  await store.setMeta('head', h);
  await store.db.prepare("DELETE FROM meta WHERE k = 'needs_tree_sync'").run();
  return enqueue(store, paths, h);
}

/** Index up to `limit` queued paths. */
export async function drain(repo: RepoService, store: IndexStore, limit = DRAIN_BATCH): Promise<{ done: number; remaining: number }> {
  const needsTree = await store.getMeta('needs_tree_sync');
  if (needsTree) await syncFromTree(repo, store, needsTree);
  const q = await store.db.prepare('SELECT path, head FROM reindex_queue ORDER BY enqueued_at LIMIT ?').bind(limit).all<{ path: string; head: string }>();
  if (q.results.length === 0) return { done: 0, remaining: 0 };
  const head = q.results[q.results.length - 1]!.head;
  const tree = await repo.tree(await repo.treeShaOf(head));
  // Config first: page classification depends on it.
  const cfgItem = q.results.find((r) => r.path === CONFIG_PATH) ? tree.get(CONFIG_PATH) : undefined;
  if (cfgItem) {
    await store.run([store.setMetaStmt('config', await repo.text(cfgItem.sha)), store.setMetaStmt('config_sha', cfgItem.sha)]);
  }
  const config = await store.config();
  const indexed = await store.pageShas();
  const ctx = await store.context();
  const stmts: D1PreparedStatement[] = [];
  for (const { path } of q.results) {
    const item = tree.get(path);
    if (path !== CONFIG_PATH) {
      if (!item) {
        stmts.push(...store.deletePageStatements(path), store.db.prepare('DELETE FROM assets WHERE path = ?').bind(path));
      } else if (isPagePath(path, config)) {
        if (indexed.get(path) !== item.sha) stmts.push(...store.pageStatements(store.rowsFor(path, await repo.text(item.sha), item.sha, ctx), 'external'));
      } else if (isAssetPath(path, config)) {
        stmts.push(store.db.prepare('INSERT INTO assets (path, sha, size) VALUES (?, ?, ?) ON CONFLICT(path) DO UPDATE SET sha = excluded.sha, size = excluded.size').bind(path, item.sha, item.size ?? 0));
      }
    }
    stmts.push(store.db.prepare('DELETE FROM reindex_queue WHERE path = ? AND head = ?').bind(path, head));
  }
  await store.run(stmts);
  const rem = await store.db.prepare('SELECT COUNT(*) AS n FROM reindex_queue').first<{ n: number }>();
  return { done: q.results.length, remaining: rem?.n ?? 0 };
}
