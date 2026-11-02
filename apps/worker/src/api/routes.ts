import { Hono } from 'hono';
import { allowedIds, branch, REQUIRED_SECRETS, type Env } from '../env.ts';
import { csrfOk, readSession, type SessionUser } from '../auth/session.ts';
import { IndexStore } from '../db/store.ts';
import { Queries, type Selector } from '../db/queries.ts';
import { RepoService } from '../repo/service.ts';
import { commitChanges, type ChangeInput, type CommitOutcome } from '../repo/commit.ts';
import { drain, enqueue, syncFromTree } from '../repo/sync.ts';
import { parseTrailers, subjectOf } from '../repo/actor.ts';
import { contentTypeFor, noStore } from '../util/http.ts';
import { b64Encode } from '../util/crypto.ts';
import { GitHubError } from '../github/client.ts';
import { revertCommit } from '../repo/revert.ts';

export const VERSION = '0.1.0';

type Vars = { user: SessionUser; repo: RepoService; store: IndexStore; q: Queries };
export const api = new Hono<{ Bindings: Env; Variables: Vars }>();

/** Health is public and reports booleans only. */
api.get('/health', async (c) => {
  let migrated = false;
  let pages = 0;
  try {
    const r = await c.env.DB.prepare('SELECT COUNT(*) AS n FROM pages').first<{ n: number }>();
    pages = r?.n ?? 0;
    migrated = true;
  } catch {
    migrated = false;
  }
  const secrets = Object.fromEntries(REQUIRED_SECRETS.map((k) => [k, !!c.env[k]]));
  return c.json({
    version: VERSION,
    d1: { migrated, pages },
    kv: !!c.env.OAUTH_KV,
    secrets,
    repo: { owner: c.env.GITHUB_OWNER || null, repo: c.env.GITHUB_REPO || null, branch: branch(c.env) },
    allowlist: allowedIds(c.env).size,
  });
});

api.use('*', async (c, next) => {
  if (c.req.path.endsWith('/health')) return next();
  const user = await readSession(c, allowedIds(c.env));
  if (!user) return c.json({ error: 'Sign in first.', login: '/auth/login' }, 401);
  if (c.req.method !== 'GET' && c.req.method !== 'HEAD' && !csrfOk(c)) return c.json({ error: 'CSRF check failed. Reload the app.' }, 403);
  c.set('user', user);
  c.set('repo', new RepoService(c.env));
  const store = new IndexStore(c.env.DB);
  c.set('store', store);
  c.set('q', new Queries(c.env.DB));
  noStore(c);
  return next();
});

api.onError((e, c) => {
  if (e instanceof GitHubError) return c.json({ error: e.message }, e.status === 401 || e.status === 403 ? 502 : (Math.min(Math.max(e.status, 400), 599) as 500));
  console.error(e);
  return c.json({ error: (e as Error).message }, 500);
});

/** Background work; awaited inline when there is no execution context (tests). */
async function waitUntil(c: { executionCtx: { waitUntil(p: Promise<unknown>): void } }, p: Promise<unknown>): Promise<void> {
  const safe = p.catch((e) => console.error(e));
  try {
    c.executionCtx.waitUntil(safe);
  } catch {
    await safe;
  }
}

api.get('/me', (c) => {
  const origin = c.env.PUBLIC_URL ?? new URL(c.req.url).origin;
  return c.json({ user: c.get('user'), mcpUrl: `${origin}/mcp`, repo: `${c.env.GITHUB_OWNER}/${c.env.GITHUB_REPO}`, branch: branch(c.env), version: VERSION });
});

api.get('/tree', async (c) => {
  const store = c.get('store');
  let head = await store.getMeta('head');
  if (!head) {
    // First run: index the repo progressively.
    const n = await syncFromTree(c.get('repo'), store);
    if (n) await drain(c.get('repo'), store, 30);
    head = await store.getMeta('head');
  }
  const etag = `"${head ?? 'none'}:${(await store.getMeta('index_rev')) ?? ''}"`;
  const pages = await c.get('q').tree();
  if (c.req.header('if-none-match') === etag && pages.length) return c.body(null, 304);
  c.header('etag', etag);
  const config = await store.config();
  return c.json({ head, pages, config: { assets_dir: config.assets_dir, link_relations: config.link_relations, default_profile: config.default_profile, image_max_px: config.image_max_px, image_formats: config.image_formats, page_size_warn_kb: config.page_size_warn_kb, actors: config.actors } });
});

api.get('/page', async (c) => {
  const path = c.req.query('path') ?? '';
  const store = c.get('store');
  const repo = c.get('repo');
  let rec = await store.getPage(path);
  let sha = rec?.sha;
  if (!sha) {
    const head = await repo.head(10_000);
    sha = (await repo.tree(await repo.treeShaOf(head))).get(path)?.sha;
    if (!sha) return c.json({ error: `No page at /${path}.` }, 404);
  }
  if (c.req.header('if-none-match') === `"${sha}"`) return c.body(null, 304);
  const content = await repo.text(sha);
  if (!rec) {
    await store.run(store.pageStatements(store.rowsFor(path, content, sha, await store.context())));
    rec = await store.getPage(path);
  }
  const include = (c.req.query('include') ?? 'content,meta,backlinks,outline').split(',');
  const q = c.get('q');
  c.header('etag', `"${sha}"`);
  return c.json({
    path,
    sha,
    ...(include.includes('content') ? { content } : {}),
    ...(include.includes('meta') ? { meta: rec } : {}),
    ...(include.includes('backlinks') ? { backlinks: await q.backlinks(path) } : {}),
    ...(include.includes('outline') ? { outline: await q.headings(path) } : {}),
  });
});

api.get('/blob', async (c) => {
  const path = c.req.query('path') ?? '';
  const repo = c.get('repo');
  let sha = c.req.query('sha') ?? (await c.env.DB.prepare('SELECT sha FROM assets WHERE path = ?').bind(path).first<{ sha: string }>())?.sha;
  if (!sha) sha = (await repo.tree(await repo.treeShaOf(await repo.head(10_000)))).get(path)?.sha;
  if (!sha) return c.json({ error: `No file at /${path}.` }, 404);
  const bytes = await repo.blob(sha);
  return new Response(bytes, {
    headers: {
      'content-type': contentTypeFor(path),
      'cache-control': c.req.query('sha') ? 'private, max-age=31536000, immutable' : 'private, max-age=0, must-revalidate',
      etag: `"${sha}"`,
      'content-security-policy': "default-src 'none'; style-src 'unsafe-inline'; sandbox",
      'x-content-type-options': 'nosniff',
    },
  });
});

/** Changed paths since a head the client knows. Also keeps the index fresh without webhooks. */
api.get('/changes', async (c) => {
  const since = c.req.query('since') ?? '';
  const store = c.get('store');
  const repo = c.get('repo');
  let head = await store.getMeta('head');
  const checked = Number((await store.getMeta('head_checked_at')) ?? 0);
  if (Date.now() - checked > 15_000) {
    const live = await repo.head();
    await store.setMeta('head_checked_at', String(Date.now()));
    if (live !== head) {
      if (head) {
        const diff = await repo.gh.compare(head, live);
        await enqueue(store, diff.files.flatMap((f) => [f.filename, ...(f.previous_filename ? [f.previous_filename] : [])]), live);
      } else await syncFromTree(repo, store, live);
      await store.setMeta('head', live);
      head = live;
    }
  }
  const pending = await c.env.DB.prepare('SELECT COUNT(*) AS n FROM reindex_queue').first<{ n: number }>();
  if ((pending?.n ?? 0) > 0) await waitUntil(c, drain(repo, store));
  if (!head || since === head) return c.json({ head, changed: [], pendingIndex: pending?.n ?? 0 });
  if (!/^[0-9a-f]{40}$/.test(since)) return c.json({ head, reset: true, changed: [] });
  try {
    const diff = await repo.gh.compare(since, head);
    return c.json({ head, changed: diff.files.map((f) => ({ path: f.filename, status: f.status, sha: f.sha, previous: f.previous_filename ?? null })), pendingIndex: pending?.n ?? 0 });
  } catch (e) {
    if (e instanceof GitHubError && e.status === 404) return c.json({ head, reset: true, changed: [] });
    throw e;
  }
});

function commitResponse(c: { json: (b: unknown, s?: number) => Response }, r: CommitOutcome): Response {
  if (r.ok) return c.json(r);
  if (r.status === 409) return c.json({ error: 'Conflict: the file changed since you loaded it.', conflicts: r.conflicts, head: r.head }, 409);
  return c.json({ error: r.error, code: r.code }, r.status);
}

api.post('/commit', async (c) => {
  const body = (await c.req.json()) as { changes: ChangeInput[]; message?: string };
  const user = c.get('user');
  const r = await commitChanges(c.get('repo'), c.get('store'), {
    changes: body.changes ?? [],
    meta: { actor: 'human', client: 'web', user: { id: user.id, login: user.login } },
    ...(body.message ? { message: body.message } : {}),
  });
  return commitResponse(c, r);
});

api.post('/revert', async (c) => {
  const { sha } = (await c.req.json()) as { sha: string };
  const user = c.get('user');
  return commitResponse(c, await revertCommit(c.get('repo'), c.get('store'), sha, { actor: 'human', client: 'web', user: { id: user.id, login: user.login } }));
});

api.get('/search', async (c) => c.json({ results: await c.get('q').search(c.req.query('q') ?? '', Number(c.req.query('limit') ?? 20)) }));

api.get('/backlinks', async (c) => c.json({ backlinks: await c.get('q').backlinks(c.req.query('path') ?? '', rels(c.req.query('rel'))) }));

function rels(s: string | undefined): string[] | undefined {
  const r = (s ?? '').split(',').map((x) => x.trim()).filter(Boolean);
  return r.length ? r : undefined;
}

function selector(s: string | undefined): Selector {
  // Selector syntax: "under:architecture", "tag:x", "status:active", "paths:a.md|b.md", combined with ';'
  const out: Selector = {};
  for (const part of (s ?? '').split(';')) {
    const [k, ...rest] = part.split(':');
    const v = rest.join(':').trim();
    if (!v) continue;
    if (k === 'under') out.under = v;
    else if (k === 'tag') out.tag = v;
    else if (k === 'status') out.status = v;
    else if (k === 'paths') out.paths = v.split('|').filter(Boolean);
  }
  return out;
}

api.get('/links', async (c) => {
  const dir = (c.req.query('dir') ?? 'both') as 'in' | 'out' | 'both';
  const scope: Selector = {};
  for (const k of ['under', 'tag', 'status'] as const) {
    const v = c.req.query(k);
    if (v) scope[k] = v;
  }
  return c.json(await c.get('q').links(c.req.query('page') ?? '', dir, rels(c.req.query('rel')), scope));
});

api.get('/matrix', async (c) => c.json(await c.get('q').matrix(selector(c.req.query('rows')), selector(c.req.query('cols')), rels(c.req.query('rel')))));

api.get('/matrix/cell', async (c) => c.json({ links: await c.get('q').cell(c.req.query('src') ?? '', c.req.query('dst') ?? '', rels(c.req.query('rel'))) }));

api.get('/neighborhood', async (c) =>
  c.json(await c.get('q').neighborhood(c.req.query('page') ?? '', c.req.query('depth') === '2' ? 2 : 1, rels(c.req.query('rel')), Math.min(Number(c.req.query('limit') ?? 40), 120))),
);

api.get('/compare', async (c) => c.json(await c.get('q').compare(c.req.query('a') ?? '', c.req.query('b') ?? '')));

api.get('/unlinked', async (c) => c.json({ mentions: await c.get('q').unlinked(c.req.query('page') ?? '') }));

api.get('/broken', async (c) => c.json({ links: await c.get('q').brokenLinks() }));

api.get('/tags', async (c) => c.json({ tags: await c.get('q').tags() }));

api.get('/history', async (c) => {
  const path = c.req.query('path') ?? '';
  const commits = await c.get('repo').gh.listCommits({ path, perPage: Number(c.req.query('limit') ?? 30) });
  return c.json({
    commits: commits.map((x) => ({ sha: x.sha, message: subjectOf(x.commit.message), author: x.commit.author.name, at: x.commit.author.date, ...parseTrailers(x.commit.message) })),
  });
});

api.get('/version', async (c) => {
  // Content of a path at a commit (for history preview and restore).
  const path = c.req.query('path') ?? '';
  const repo = c.get('repo');
  const tree = await repo.tree(await repo.treeShaOf(c.req.query('sha') ?? ''));
  const item = tree.get(path);
  if (!item) return c.json({ error: 'The page did not exist at that commit.' }, 404);
  return c.json({ path, sha: item.sha, content: await repo.text(item.sha) });
});

api.get('/activity', async (c) => c.json({ activity: await c.get('q').activity(Number(c.req.query('limit') ?? 50), c.req.query('actor') || undefined, Number(c.req.query('before') ?? 0) || undefined) }));

api.get('/recent', async (c) => c.json({ recent: await c.get('q').recentPages() }));

/** Page contents for export (client normalizes). Paginated to respect the subrequest budget. */
api.get('/bundle', async (c) => {
  const under = (c.req.query('under') ?? '').replace(/^\/+|\/+$/g, '');
  const cursor = Number(c.req.query('cursor') ?? 0);
  const pageSize = 30;
  const all = (await c.get('store').allPages()).filter((p) => !under || p.path === `${under}.md` || p.path.startsWith(`${under}/`));
  const slice = all.slice(cursor, cursor + pageSize);
  const repo = c.get('repo');
  const pages = [];
  for (const p of slice) pages.push({ path: p.path, sha: p.sha, content: await repo.text(p.sha) });
  const imgs = slice.length
    ? (await c.env.DB.prepare(`SELECT DISTINCT i.path, a.sha FROM images i LEFT JOIN assets a ON a.path = i.path WHERE i.src IN (${slice.map(() => '?').join(',')})`).bind(...slice.map((p) => p.path)).all<{ path: string; sha: string | null }>()).results
    : [];
  return c.json({ pages, images: imgs, next: cursor + pageSize < all.length ? cursor + pageSize : null, total: all.length });
});

api.get('/images', async (c) => {
  const under = c.req.query('under');
  const r = await c.env.DB.prepare('SELECT path, sha, size FROM assets ORDER BY path').all<{ path: string; sha: string; size: number }>();
  return c.json({ images: r.results.filter((i) => !under || i.path.startsWith(under.replace(/^\/+/, ''))) });
});

api.post('/reindex', async (c) => {
  const n = await syncFromTree(c.get('repo'), c.get('store'));
  const r = await drain(c.get('repo'), c.get('store'));
  return c.json({ queued: n, ...r });
});

export { b64Encode };
