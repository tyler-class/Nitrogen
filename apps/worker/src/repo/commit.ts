/**
 * The commit pipeline shared by the PWA and MCP (brief 10.3): verify base shas against head,
 * build a tree on top of head, create one commit with trailers, fast-forward the ref (never force),
 * retry when head moved, then update the D1 index in the same request.
 */
import { checkAssetPath, checkPagePath, rewriteLinks, scanPage, type NitrogenConfig } from '@nitrogen/core/light';
import { GitHubError } from '../github/client.ts';
import type { RepoService } from './service.ts';
import type { IndexStore } from '../db/store.ts';
import { commitMessage, defaultSubject, type CommitMeta } from './actor.ts';
import { b64Decode, gitBlobSha } from '../util/crypto.ts';

export const LIMITS = { maxFiles: 30, pageBytes: 500 * 1024, imageBytes: 8 * 1024 * 1024 };

export interface ChangeInput {
  path: string;
  op: 'put' | 'delete' | 'move';
  /** UTF-8 content for put. */
  content?: string;
  /** Base64 content for binary put (images). */
  contentB64?: string;
  /**
   * Blob sha the change was based on. `null` = the file must not exist (create).
   * `undefined` = no check (last writer wins; only for internal callers).
   */
  baseSha?: string | null;
  /** Destination for move. */
  to?: string;
}

export interface Conflict {
  path: string;
  /** Current content at head (null when deleted / binary). */
  theirs: string | null;
  theirsSha: string | null;
}

export type CommitOutcome =
  | { ok: true; commitSha: string; head: string; results: { path: string; op: string; sha: string | null }[]; rewritten: string[] }
  | { ok: false; status: 409; conflicts: Conflict[]; head: string }
  | { ok: false; status: 400 | 413 | 422 | 423; error: string; code?: string };

export class CommitError extends Error {
  constructor(
    public status: 400 | 413 | 422 | 423,
    message: string,
    public code?: string,
  ) {
    super(message);
  }
}

interface Planned {
  puts: Map<string, { text?: string; bytes?: Uint8Array }>;
  deletes: Set<string>;
  results: { path: string; op: string }[];
  rewritten: string[];
}

function validate(changes: ChangeInput[], config: NitrogenConfig): void {
  if (changes.length === 0) throw new CommitError(400, 'No changes.');
  if (changes.length > LIMITS.maxFiles) throw new CommitError(413, `A commit may change at most ${LIMITS.maxFiles} files.`);
  const seen = new Set<string>();
  const check = (path: string, binary: boolean) => {
    // Export copies (brief 7.3) live under /_exports/<profile>/ and are never indexed.
    if (/^_exports\/(gfm|commonmark)\/[^]+\.md$/.test(path) && !path.includes('..') && !path.includes('//')) return;
    const r = binary ? checkAssetPath(path, config.assets_dir, config.image_formats) : checkPagePath(path, config.ignore);
    if (!r.ok) throw new CommitError(422, `E009 ${path}: ${r.reason}`, 'E009');
  };
  for (const c of changes) {
    if (seen.has(c.path)) throw new CommitError(400, `Duplicate change for ${c.path}.`);
    seen.add(c.path);
    const isAsset = !c.path.endsWith('.md');
    if (c.op === 'put') {
      if (c.content === undefined && c.contentB64 === undefined) throw new CommitError(400, `put ${c.path} needs content.`);
      check(c.path, isAsset);
      if (c.content !== undefined && new TextEncoder().encode(c.content).length > LIMITS.pageBytes)
        throw new CommitError(413, `${c.path} is larger than ${LIMITS.pageBytes / 1024} KB.`);
      if (c.contentB64 !== undefined && (c.contentB64.length * 3) / 4 > LIMITS.imageBytes)
        throw new CommitError(413, `${c.path} is larger than ${LIMITS.imageBytes / 1024 / 1024} MB.`);
    } else if (c.op === 'delete') {
      check(c.path, isAsset);
    } else if (c.op === 'move') {
      if (!c.to) throw new CommitError(400, `move ${c.path} needs "to".`);
      check(c.path, isAsset);
      check(c.to, isAsset);
      if (seen.has(c.to)) throw new CommitError(400, `Duplicate change for ${c.to}.`);
      seen.add(c.to);
    } else throw new CommitError(400, `Unknown op.`);
  }
}

export interface CommitRequest {
  changes: ChangeInput[];
  meta: CommitMeta;
  message?: string;
  /** Rewrite inbound links when moving pages (default true). */
  rewriteInbound?: boolean;
  /** Refuse writes to locked pages (MCP). */
  respectLocks?: boolean;
}

export async function commitChanges(repo: RepoService, store: IndexStore, req: CommitRequest): Promise<CommitOutcome> {
  const config = await store.config();
  try {
    validate(req.changes, config);
  } catch (e) {
    if (e instanceof CommitError) return { ok: false, status: e.status, error: e.message, ...(e.code ? { code: e.code } : {}) };
    throw e;
  }
  let lastError: unknown = null;
  for (let attempt = 0; attempt < 3; attempt++) {
    const head = await repo.head();
    const treeSha = await repo.treeShaOf(head);
    const tree = await repo.tree(treeSha);
    // 1. Optimistic concurrency: verify base shas.
    const conflicts: Conflict[] = [];
    for (const c of req.changes) {
      if (c.baseSha === undefined) continue;
      const cur = tree.get(c.path)?.sha ?? null;
      if (cur !== c.baseSha) {
        const theirs = cur && c.path.endsWith('.md') ? await repo.text(cur) : null;
        conflicts.push({ path: c.path, theirs, theirsSha: cur });
      }
    }
    if (conflicts.length) return { ok: false, status: 409, conflicts, head };
    // 2. Locks.
    if (req.respectLocks) {
      for (const c of req.changes) {
        const cur = tree.get(c.path);
        if (cur && c.path.endsWith('.md')) {
          const text = await repo.text(cur.sha);
          if (scanPage(text).frontmatter.data.locked === true) return { ok: false, status: 423, error: `E010 ${c.path} is locked (locked: true).`, code: 'E010' };
        }
      }
    }
    // 3. Plan.
    let plan: Planned;
    try {
      plan = await planChanges(repo, store, tree, req);
    } catch (e) {
      if (e instanceof CommitError) return { ok: false, status: e.status, error: e.message, ...(e.code ? { code: e.code } : {}) };
      throw e;
    }
    // 4. Blobs and tree.
    const entries: { path: string; mode: '100644'; type: 'blob'; sha?: string | null; content?: string }[] = [];
    for (const [path, v] of plan.puts) {
      if (v.text !== undefined) entries.push({ path, mode: '100644', type: 'blob', content: v.text });
      else entries.push({ path, mode: '100644', type: 'blob', sha: await repo.gh.createBlob(v.bytes!) });
    }
    for (const path of plan.deletes) if (tree.has(path)) entries.push({ path, mode: '100644', type: 'blob', sha: null });
    const paths = [...plan.results.map((r) => r.path)];
    const op = req.changes.length === 1 ? (req.changes[0]!.op === 'put' ? (tree.has(req.changes[0]!.path) ? 'update' : 'create') : req.changes[0]!.op) : 'update';
    const message = commitMessage(req.message?.trim() || defaultSubject(op, paths, req.meta), req.meta);
    const newTree = await repo.gh.createTree(treeSha, entries);
    if (newTree === treeSha) {
      // Nothing changed (e.g. a save of already-committed content): no empty commits.
      return { ok: true, commitSha: head, head, results: plan.results.map((r) => ({ ...r, sha: tree.get(r.path)?.sha ?? null })), rewritten: [] };
    }
    const author = req.meta.user ? { name: req.meta.user.login, email: `${req.meta.user.id}+${req.meta.user.login}@users.noreply.github.com` } : undefined;
    const commit = await repo.gh.createCommit(message, newTree, [head], author);
    try {
      await repo.gh.updateRef(repo.branch, commit.sha);
    } catch (e) {
      if (e instanceof GitHubError && e.status === 422) {
        lastError = e;
        continue; // head moved: rebuild on the new head (base shas are re-verified)
      }
      throw e;
    }
    repo.rememberHead(commit.sha);
    // 5. Index.
    const results: { path: string; op: string; sha: string | null }[] = [];
    const shas = new Map<string, string>();
    for (const [path, v] of plan.puts) shas.set(path, await gitBlobSha(v.text ?? v.bytes!));
    for (const r of plan.results) results.push({ ...r, sha: shas.get(r.path) ?? null });
    await indexAfterCommit(store, plan, shas, commit.sha, req.meta, message, paths);
    return { ok: true, commitSha: commit.sha, head: commit.sha, results, rewritten: plan.rewritten };
  }
  return { ok: false, status: 422, error: `The branch kept moving; gave up after 3 attempts. ${(lastError as Error)?.message ?? ''}`.trim() };
}

async function planChanges(repo: RepoService, store: IndexStore, tree: Map<string, { sha: string }>, req: CommitRequest): Promise<Planned> {
  const puts = new Map<string, { text?: string; bytes?: Uint8Array }>();
  const deletes = new Set<string>();
  const results: { path: string; op: string }[] = [];
  const mapping = new Map<string, string>();
  for (const c of req.changes) {
    if (c.op === 'put') {
      puts.set(c.path, c.content !== undefined ? { text: c.content } : { bytes: b64Decode(c.contentB64!) });
      results.push({ path: c.path, op: tree.has(c.path) ? 'update' : 'create' });
    } else if (c.op === 'delete') {
      if (!tree.has(c.path)) throw new CommitError(422, `${c.path} does not exist.`);
      deletes.add(c.path);
      results.push({ path: c.path, op: 'delete' });
    } else {
      const src = tree.get(c.path);
      if (!src) throw new CommitError(422, `${c.path} does not exist.`);
      if (tree.has(c.to!)) throw new CommitError(422, `${c.to} already exists.`);
      mapping.set(c.path, c.to!);
      deletes.add(c.path);
      const bytes = await repo.blob(src.sha);
      puts.set(c.to!, c.path.endsWith('.md') ? { text: new TextDecoder().decode(bytes) } : { bytes });
      results.push({ path: c.to!, op: 'move' });
    }
  }
  const rewritten: string[] = [];
  if (mapping.size && req.rewriteInbound !== false) {
    // Pages that link to a moved path, per the index, plus the moved pages themselves.
    const olds = [...mapping.keys()];
    const placeholders = olds.map(() => '?').join(',');
    const inbound = await store.db
      .prepare(`SELECT DISTINCT src FROM links WHERE dst IN (${placeholders}) UNION SELECT DISTINCT src FROM images WHERE path IN (${placeholders})`)
      .bind(...olds, ...olds)
      .all<{ src: string }>();
    const candidates = new Set<string>([...inbound.results.map((r) => r.src), ...olds.filter((o) => o.endsWith('.md'))]);
    for (const src of candidates) {
      if (!src.endsWith('.md')) continue;
      const finalPath = mapping.get(src) ?? src;
      if (deletes.has(finalPath)) continue;
      const pending = puts.get(finalPath);
      let text: string;
      if (pending?.text !== undefined) text = pending.text;
      else {
        const cur = tree.get(src);
        if (!cur) continue;
        text = await repo.text(cur.sha);
      }
      const next = rewriteLinks(text, mapping, src, finalPath);
      if (next !== text) {
        puts.set(finalPath, { text: next });
        if (!results.some((r) => r.path === finalPath)) {
          results.push({ path: finalPath, op: 'update' });
          rewritten.push(finalPath);
        }
      }
    }
    if (puts.size + deletes.size > LIMITS.maxFiles + mapping.size) throw new CommitError(413, `This move touches more than ${LIMITS.maxFiles} files.`);
  }
  return { puts, deletes, results, rewritten };
}

async function indexAfterCommit(store: IndexStore, plan: Planned, shas: Map<string, string>, commitSha: string, meta: CommitMeta, message: string, paths: string[]): Promise<void> {
  const ctx = await store.context();
  const stmts: D1PreparedStatement[] = [];
  for (const path of plan.deletes) {
    if (path.endsWith('.md')) stmts.push(...store.deletePageStatements(path));
    else stmts.push(store.db.prepare('DELETE FROM assets WHERE path = ?').bind(path));
  }
  for (const [path, v] of plan.puts) {
    const sha = shas.get(path)!;
    if (path.endsWith('.md') && v.text !== undefined) stmts.push(...store.pageStatements(store.rowsFor(path, v.text, sha, ctx), meta.actor));
    else stmts.push(store.db.prepare('INSERT INTO assets (path, sha, size) VALUES (?, ?, ?) ON CONFLICT(path) DO UPDATE SET sha = excluded.sha, size = excluded.size').bind(path, sha, v.bytes?.length ?? 0));
  }
  stmts.push(store.setMetaStmt('head', commitSha));
  const now = new Date().toISOString();
  stmts.push(
    store.activityStmt({
      sha: commitSha,
      actor: meta.actor,
      client: meta.client,
      tool: meta.tool ?? null,
      op: plan.results.length === 1 ? plan.results[0]!.op : 'update',
      path: paths[0] ?? null,
      message: message.split('\n')[0]!,
      files: plan.results.length,
      at: now,
    }),
  );
  await store.run(stmts);
}
