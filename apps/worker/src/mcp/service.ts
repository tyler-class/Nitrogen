/**
 * MCP tool implementations as plain async functions over the same services as the PWA API.
 * Every write: path check (E009) -> lock check (E010) -> autofix -> lint (errors block unless
 * force; never for E008/E009/E010) -> one commit with Nitrogen-Actor: claude -> index update.
 */
import {
  autofix,
  checkPagePath,
  checkWrite,
  lintScan,
  scanPage,
  type Diagnostic,
  type Fix,
  type VaultContext,
} from '@nitrogen/core/light';
// Full-mode core (remark) only for normalize/export tools; everything else uses the light scanner.
import { normalize, exportPages, type Profile } from '@nitrogen/core';
import { IndexStore } from '../db/store.ts';
import { Queries, type Selector } from '../db/queries.ts';
import { RepoService } from '../repo/service.ts';
import { commitChanges, type ChangeInput, type CommitOutcome } from '../repo/commit.ts';
import { revertCommit } from '../repo/revert.ts';
import { parseTrailers, subjectOf, type CommitMeta } from '../repo/actor.ts';
import { applyPatch, PatchError, readSection, type PatchOp } from './patch.ts';
import { rateLimit } from '../util/rate.ts';
import { b64Decode } from '../util/crypto.ts';
import type { Env } from '../env.ts';

export class ToolError extends Error {
  constructor(
    message: string,
    public data: Record<string, unknown> = {},
  ) {
    super(message);
  }
}

export interface WriteResult {
  commitSha: string;
  path: string;
  sha: string | null;
  warnings: Diagnostic[];
  autofixed: Fix[];
  url: string;
  rewritten?: string[];
}

const NEVER_FORCE = new Set(['E008', 'E009', 'E010']);
export const WRITES_PER_HOUR = 60;

function fmtDiag(d: Diagnostic): string {
  return `${d.code} ${d.message}${d.line ? ` (line ${d.line})` : ''}${d.fix ? ` ${d.fix}` : ''}`;
}

export class McpService {
  readonly repo: RepoService;
  readonly store: IndexStore;
  readonly q: Queries;

  constructor(
    readonly env: Env,
    readonly user: { id: number; login: string },
    readonly origin: string,
  ) {
    this.repo = new RepoService(env);
    this.store = new IndexStore(env.DB);
    this.q = new Queries(env.DB);
  }

  pageUrl(path: string): string {
    return `${this.origin}/p/${path.split('/').map(encodeURIComponent).join('/')}`;
  }

  private meta(tool: string): CommitMeta {
    return { actor: 'claude', client: 'mcp', tool, user: this.user };
  }

  private async ctx(): Promise<VaultContext> {
    return this.store.context();
  }

  private async headTree() {
    const head = await this.repo.head(5_000);
    return this.repo.tree(await this.repo.treeShaOf(head));
  }

  /** Current content + sha of a page, or null. */
  async current(path: string): Promise<{ content: string; sha: string } | null> {
    const item = (await this.headTree()).get(path);
    if (!item) return null;
    return { content: await this.repo.text(item.sha), sha: item.sha };
  }

  private async limit(): Promise<void> {
    const r = await rateLimit(this.env.DB, `mcp-write:${this.user.id}`, WRITES_PER_HOUR, 3600);
    if (!r.ok) throw new ToolError(`Rate limit: at most ${WRITES_PER_HOUR} writes per hour. Try again after ${new Date(r.resetAt * 1000).toISOString()}.`);
  }

  /** Validate + autofix + lint one page. Throws ToolError on blocking errors. */
  async prepare(path: string, content: string, opts: { force?: boolean; existing?: string | null }): Promise<{ content: string; warnings: Diagnostic[]; autofixed: Fix[] }> {
    const ctx = await this.ctx();
    const pre = checkWrite(path, opts.existing ? scanPage(opts.existing) : null, ctx);
    if (pre.length) throw new ToolError(pre.map(fmtDiag).join('\n'), { diagnostics: pre });
    const fixed = autofix(content, ctx, { path });
    // The page itself may be new: add it so self-links and anchors resolve.
    const selfCtx: VaultContext = ctx.pages.some((p) => p.path === path) ? ctx : { ...ctx, pages: [...ctx.pages, { path, title: path, aliases: [] }] };
    const diags = lintScan(scanPage(fixed.src), fixed.src, selfCtx, { path });
    const errors = diags.filter((d) => d.severity === 'error');
    const blocking = errors.filter((d) => !opts.force || NEVER_FORCE.has(d.code));
    if (blocking.length)
      throw new ToolError(`Lint errors block this write:\n${blocking.map(fmtDiag).join('\n')}${blocking.some((d) => !NEVER_FORCE.has(d.code)) ? '\nFix them, or pass force: true to write anyway.' : ''}`, { diagnostics: errors });
    return { content: fixed.src, warnings: diags.filter((d) => d.severity === 'warning' || opts.force), autofixed: fixed.fixes };
  }

  private async commit(changes: ChangeInput[], tool: string, message?: string): Promise<Extract<CommitOutcome, { ok: true }>> {
    const r = await commitChanges(this.repo, this.store, { changes, meta: this.meta(tool), respectLocks: true, ...(message ? { message } : {}) });
    if (r.ok) return r;
    if (r.status === 409) {
      const c = r.conflicts[0]!;
      throw new ToolError(`Stale base_sha for ${c.path}: the page changed. Current sha is ${c.theirsSha ?? '(deleted)'}. Read the page again and reapply your change.`, { conflicts: r.conflicts.map((x) => ({ path: x.path, sha: x.theirsSha })) });
    }
    throw new ToolError(r.error, { code: r.code });
  }

  // ---------------- reads ----------------

  async listTree(path = '', depth = 2) {
    const prefix = path.replace(/^\/+|\/+$/g, '');
    const pages = await this.q.tree();
    const base = prefix ? prefix.split('/').length : 0;
    const within = pages.filter((p) => !prefix || p.path.startsWith(`${prefix}/`) || p.path === `${prefix}.md`);
    const rows = within
      .filter((p) => p.path.split('/').length - base <= depth)
      .map((p) => ({ path: p.path, title: p.title, order: p.ord, status: p.status, children: within.filter((c) => p.path.endsWith('/index.md') && c.path !== p.path && c.path.startsWith(p.path.slice(0, -'index.md'.length))).length }));
    return { pages: rows, total: within.length };
  }

  async readPage(path: string, section?: string, include: string[] = ['content', 'meta']) {
    const cur = await this.current(path);
    if (!cur) throw new ToolError(`No page at ${path}. Use list_tree or search to find pages.`);
    const out: Record<string, unknown> = { path, sha: cur.sha, url: this.pageUrl(path) };
    if (include.includes('content')) {
      try {
        out.content = section ? readSection(cur.content, section) : cur.content;
      } catch (e) {
        throw new ToolError((e as Error).message);
      }
    }
    if (include.includes('meta')) out.meta = await this.store.getPage(path);
    if (include.includes('backlinks')) out.backlinks = await this.q.backlinks(path);
    if (include.includes('outline')) out.outline = await this.q.headings(path);
    return out;
  }

  search(query: string, limit = 10, filters: Selector & { tags?: string[] } = {}) {
    const parts = [query];
    if (filters.under) parts.push(`under:${filters.under}`);
    if (filters.tags?.[0]) parts.push(`tag:${filters.tags[0]}`);
    if (filters.status) parts.push(`status:${filters.status}`);
    return this.q.search(parts.join(' '), Math.min(limit, 50));
  }

  async getLinks(path: string) {
    return this.q.outgoing(path);
  }

  // ---------------- writes ----------------

  async createPage(path: string, content: string, opts: { force?: boolean; createParents?: boolean; message?: string } = {}): Promise<WriteResult> {
    await this.limit();
    const tree = await this.headTree();
    if (tree.has(path)) throw new ToolError(`${path} already exists (sha ${tree.get(path)!.sha}). Use patch_page or write_page.`);
    const prepared = await this.prepare(path, content, { ...(opts.force ? { force: true } : {}) });
    const changes: ChangeInput[] = [{ path, op: 'put', content: prepared.content, baseSha: null }];
    if (opts.createParents) {
      const segs = path.split('/').slice(0, -1);
      for (let i = 1; i <= segs.length; i++) {
        const idx = `${segs.slice(0, i).join('/')}/index.md`;
        if (idx !== path && !tree.has(idx)) {
          const name = segs[i - 1]!;
          changes.push({ path: idx, op: 'put', content: `# ${name.charAt(0).toUpperCase()}${name.slice(1).replace(/-/g, ' ')}\n`, baseSha: null });
        }
      }
    }
    const r = await this.commit(changes, 'create_page', opts.message);
    return { commitSha: r.commitSha, path, sha: r.results.find((x) => x.path === path)?.sha ?? null, warnings: prepared.warnings, autofixed: prepared.autofixed, url: this.pageUrl(path) };
  }

  async writePage(path: string, content: string, baseSha: string, opts: { force?: boolean; message?: string } = {}): Promise<WriteResult> {
    if (!baseSha) throw new ToolError('write_page requires base_sha (from read_page). For new pages use create_page.');
    await this.limit();
    const cur = await this.current(path);
    if (!cur) throw new ToolError(`No page at ${path}. Use create_page.`);
    const prepared = await this.prepare(path, content, { existing: cur.content, ...(opts.force ? { force: true } : {}) });
    const r = await this.commit([{ path, op: 'put', content: prepared.content, baseSha }], 'write_page', opts.message);
    return { commitSha: r.commitSha, path, sha: r.results[0]?.sha ?? null, warnings: prepared.warnings, autofixed: prepared.autofixed, url: this.pageUrl(path) };
  }

  async patchPage(path: string, ops: PatchOp[], baseSha?: string, opts: { force?: boolean; message?: string } = {}): Promise<WriteResult> {
    if (!ops?.length) throw new ToolError('patch_page needs at least one op.');
    await this.limit();
    const cur = await this.current(path);
    if (!cur) throw new ToolError(`No page at ${path}. Use create_page.`);
    if (baseSha && baseSha !== cur.sha) throw new ToolError(`Stale base_sha for ${path}. Current sha is ${cur.sha}. Read the page again.`, { sha: cur.sha });
    let next: string;
    try {
      next = applyPatch(cur.content, ops);
    } catch (e) {
      if (e instanceof PatchError) throw new ToolError(`No change made: ${e.message}`);
      throw e;
    }
    const prepared = await this.prepare(path, next, { existing: cur.content, ...(opts.force ? { force: true } : {}) });
    const r = await this.commit([{ path, op: 'put', content: prepared.content, baseSha: cur.sha }], 'patch_page', opts.message);
    return { commitSha: r.commitSha, path, sha: r.results[0]?.sha ?? null, warnings: prepared.warnings, autofixed: prepared.autofixed, url: this.pageUrl(path) };
  }

  async movePage(from: string, to: string): Promise<WriteResult> {
    await this.limit();
    const ctx = await this.ctx();
    const pc = checkPagePath(to, ctx.config.ignore);
    if (!pc.ok) throw new ToolError(`E009 ${to}: ${pc.reason}`);
    const cur = await this.current(from);
    if (!cur) throw new ToolError(`No page at ${from}.`);
    if (scanPage(cur.content).frontmatter.data.locked === true) throw new ToolError(`E010 ${from} is locked.`);
    const r = await this.commit([{ path: from, op: 'move', to }], 'move_page');
    return { commitSha: r.commitSha, path: to, sha: r.results.find((x) => x.path === to)?.sha ?? null, warnings: [], autofixed: [], url: this.pageUrl(to), rewritten: r.rewritten };
  }

  async deletePage(path: string, confirm: boolean, force = false): Promise<WriteResult> {
    if (confirm !== true) throw new ToolError('delete_page requires confirm: true.');
    await this.limit();
    const cur = await this.current(path);
    if (!cur) throw new ToolError(`No page at ${path}.`);
    if (scanPage(cur.content).frontmatter.data.locked === true) throw new ToolError(`E010 ${path} is locked.`);
    const inbound = await this.q.backlinks(path);
    if (inbound.length && !force) throw new ToolError(`${inbound.length} page(s) link to ${path}: ${inbound.map((g) => g.path).join(', ')}. Update them first, or pass force: true.`);
    const r = await this.commit([{ path, op: 'delete', baseSha: cur.sha }], 'delete_page');
    return { commitSha: r.commitSha, path, sha: null, warnings: [], autofixed: [], url: this.pageUrl(path) };
  }

  async uploadImage(filename: string, dataB64: string, alt?: string, path?: string): Promise<{ commitSha: string; path: string; markdown: string; url: string }> {
    await this.limit();
    const ctx = await this.ctx();
    const ext = (filename.split('.').pop() ?? '').toLowerCase();
    if (!ctx.config.image_formats.includes(ext)) throw new ToolError(`Image type .${ext} is not allowed. Use ${ctx.config.image_formats.join(', ')}.`);
    const bytes = b64Decode(dataB64);
    if (bytes.length > 8 * 1024 * 1024) throw new ToolError('Images must be 8 MB or smaller.');
    const now = new Date();
    const slug = filename.replace(/\.[^.]+$/, '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 40) || 'image';
    const digest = [...new Uint8Array(await crypto.subtle.digest('SHA-256', bytes))].slice(0, 3).map((b) => b.toString(16).padStart(2, '0')).join('');
    const target = path?.replace(/^\/+/, '') ?? `${ctx.config.assets_dir}/${now.getUTCFullYear()}/${String(now.getUTCMonth() + 1).padStart(2, '0')}/${slug}-${digest}.${ext}`;
    const r = await this.commit([{ path: target, op: 'put', contentB64: dataB64, baseSha: null }], 'upload_image');
    const markdown = `![${alt ?? 'Describe the image'}](/${target})`;
    return { commitSha: r.commitSha, path: target, markdown, url: `${this.origin}/api/blob?path=${encodeURIComponent(target)}` };
  }

  async listImages(under?: string) {
    const r = await this.env.DB.prepare('SELECT path, size FROM assets ORDER BY path').all<{ path: string; size: number }>();
    return r.results.filter((i) => !under || i.path.startsWith(under.replace(/^\/+/, '')));
  }

  async lint(path?: string, content?: string) {
    const ctx = await this.ctx();
    let src = content;
    if (src === undefined) {
      if (!path) throw new ToolError('Pass path or content.');
      const cur = await this.current(path);
      if (!cur) throw new ToolError(`No page at ${path}.`);
      src = cur.content;
    }
    const p = path ?? 'untitled.md';
    const fixed = autofix(src, ctx, { path: p });
    return { diagnostics: lintScan(scanPage(src), src, ctx, { path: p }), autofixable: fixed.fixes, fixedContent: fixed.src !== src ? fixed.src : undefined };
  }

  async normalizePreview(path?: string, content?: string, profile: Profile = 'gfm') {
    const ctx = await this.ctx();
    let src = content;
    if (src === undefined) {
      if (!path) throw new ToolError('Pass path or content.');
      src = (await this.current(path))?.content;
      if (src === undefined) throw new ToolError(`No page at ${path}.`);
    }
    if (src.length > 100_000) throw new ToolError('Page too large to normalize in the Worker; use the web export or the CLI.');
    return normalize(src, profile, ctx, { path: path ?? 'untitled.md' });
  }

  async exportStandard(target: string, profile: Profile = 'gfm', mode: 'return' | 'commit_copy' = 'return') {
    const ctx = await this.ctx();
    const prefix = target.replace(/^\/+|\/+$/g, '');
    const all = await this.store.allPages();
    const pages = all.filter((p) => p.path === prefix || !prefix || p.path.startsWith(`${prefix.replace(/\.md$/, '')}/`));
    if (!pages.length) throw new ToolError(`No pages at ${target}.`);
    if (pages.length > 25) throw new ToolError(`${pages.length} pages; export at most 25 at a time through MCP (use the CLI or web export for more).`);
    const withContent = [];
    for (const p of pages) withContent.push({ path: p.path, content: await this.repo.text(p.sha) });
    const r = exportPages(withContent, ctx, { profile, includeImages: false });
    if (mode === 'return') return { files: r.files, ledger: r.ledger };
    const c = await this.commit(r.files.map((f) => ({ path: `_exports/${profile}/${f.path}`, op: 'put' as const, content: f.content })), 'export_standard', `nitrogen(claude): export ${prefix || 'wiki'} as ${profile}`);
    return { commitSha: c.commitSha, paths: r.files.map((f) => `_exports/${profile}/${f.path}`), ledger: r.ledger };
  }

  async recentChanges(since?: string, limit = 20, actor?: string) {
    const rows = (await this.q.activity(Math.min(limit, 100), actor)) as { at: string }[];
    return since ? rows.filter((r) => r.at >= since) : rows;
  }

  async revert(sha: string): Promise<{ commitSha: string; url: string }> {
    await this.limit();
    const r = await revertCommit(this.repo, this.store, sha, this.meta('revert_commit'));
    if (r.ok) return { commitSha: r.commitSha, url: `${this.origin}/activity` };
    if (r.status === 409) throw new ToolError(`Cannot revert cleanly: ${r.conflicts.map((c) => c.path).join(', ')} changed since. Edit those pages instead.`);
    throw new ToolError(r.error);
  }

  async history(path: string, limit = 10) {
    const commits = await this.repo.gh.listCommits({ path, perPage: limit });
    return commits.map((c) => ({ sha: c.sha, message: subjectOf(c.commit.message), at: c.commit.author.date, ...parseTrailers(c.commit.message) }));
  }
}

