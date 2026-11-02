/**
 * Repo access: head, trees and blobs with caching. Trees are cached in isolate memory by tree sha;
 * blobs in the Cache API (free, per-colo) and memory, keyed by blob sha (content-addressed, so
 * entries never go stale).
 */
import { GitHubClient, type TreeItem } from '../github/client.ts';
import { branch, type Env } from '../env.ts';

const treeCache = new Map<string, Map<string, TreeItem>>();
const blobMem = new Map<string, Uint8Array>();
const MAX_MEM_BLOBS = 300;
const HEAD_TTL_MS = 10_000;
const headCache = new Map<string, { sha: string; at: number }>();

export class RepoService {
  readonly gh: GitHubClient;
  readonly branch: string;

  constructor(readonly env: Env) {
    this.gh = new GitHubClient(env);
    this.branch = branch(env);
  }

  private key(): string {
    return `${this.env.GITHUB_OWNER}/${this.env.GITHUB_REPO}@${this.branch}`;
  }

  /** Current head commit sha. `maxAgeMs` allows a recent cached value (0 = always ask GitHub). */
  async head(maxAgeMs = 0): Promise<string> {
    const c = headCache.get(this.key());
    if (c && maxAgeMs > 0 && Date.now() - c.at < Math.min(maxAgeMs, HEAD_TTL_MS)) return c.sha;
    const { sha } = await this.gh.getHead(this.branch);
    if (!sha) throw new Error('No head');
    this.rememberHead(sha);
    return sha;
  }

  rememberHead(sha: string): void {
    headCache.set(this.key(), { sha, at: Date.now() });
  }

  /** Commit -> tree sha. */
  async treeShaOf(commitSha: string): Promise<string> {
    return (await this.gh.getCommit(commitSha)).tree.sha;
  }

  /** Flattened blob map (path -> item) for a tree sha. */
  async tree(treeSha: string): Promise<Map<string, TreeItem>> {
    const hit = treeCache.get(treeSha);
    if (hit) return hit;
    const t = await this.gh.getTree(treeSha);
    if (t.truncated) throw new Error('Repository tree is too large for one request (truncated). Split the vault or use the Action reindex.');
    const map = new Map<string, TreeItem>();
    for (const item of t.tree) if (item.type === 'blob') map.set(item.path, item);
    treeCache.set(treeSha, map);
    if (treeCache.size > 20) treeCache.delete(treeCache.keys().next().value!);
    return map;
  }

  async blob(sha: string): Promise<Uint8Array> {
    const m = blobMem.get(sha);
    if (m) return m;
    const cacheKey = new Request(`https://nitrogen.cache/blob/${sha}`);
    const cache = typeof caches !== 'undefined' ? (caches as unknown as { default: Cache }).default : null;
    if (cache) {
      const hit = await cache.match(cacheKey);
      if (hit) {
        const bytes = new Uint8Array(await hit.arrayBuffer());
        this.memo(sha, bytes);
        return bytes;
      }
    }
    const bytes = await this.gh.getBlob(sha);
    this.memo(sha, bytes);
    if (cache) await cache.put(cacheKey, new Response(bytes, { headers: { 'cache-control': 'public, max-age=31536000, immutable' } }));
    return bytes;
  }

  async text(sha: string): Promise<string> {
    return new TextDecoder().decode(await this.blob(sha));
  }

  private memo(sha: string, bytes: Uint8Array): void {
    blobMem.set(sha, bytes);
    if (blobMem.size > MAX_MEM_BLOBS) blobMem.delete(blobMem.keys().next().value!);
  }
}

/** Test helper: drop isolate caches. */
export function resetRepoCaches(): void {
  treeCache.clear();
  blobMem.clear();
  headCache.clear();
}
