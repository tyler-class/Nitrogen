/** Minimal GitHub REST client for the Git Data API, scoped to one repo. */
import { appJwt } from './jwt.ts';
import { b64Decode, b64Encode } from '../util/crypto.ts';
import type { Env } from '../env.ts';

export class GitHubError extends Error {
  constructor(
    public status: number,
    message: string,
    public body?: unknown,
  ) {
    super(message);
  }
}

export interface TreeItem {
  path: string;
  mode: string;
  type: 'blob' | 'tree' | 'commit';
  sha: string;
  size?: number;
}

export interface CommitInfo {
  sha: string;
  tree: { sha: string };
  parents: { sha: string }[];
  message: string;
  author: { name: string; email: string; date: string };
}

export interface ListedCommit {
  sha: string;
  commit: { message: string; author: { name: string; email: string; date: string } };
  parents: { sha: string }[];
}

export interface CommitFile {
  filename: string;
  status: 'added' | 'removed' | 'modified' | 'renamed' | 'copied' | 'changed' | 'unchanged';
  sha: string | null;
  previous_filename?: string;
}

const tokenCache = new Map<string, { token: string; exp: number }>();

/** Installation token, cached in isolate memory until 5 minutes before expiry. */
export async function installationToken(env: Env, f: typeof fetch): Promise<string> {
  if (env.GITHUB_TEST_TOKEN) return env.GITHUB_TEST_TOKEN;
  const id = env.GITHUB_INSTALLATION_ID;
  if (!env.GITHUB_APP_ID || !env.GITHUB_APP_PRIVATE_KEY || !id) throw new GitHubError(503, 'GitHub App is not configured. Run `nitrogen setup`.');
  const cached = tokenCache.get(id);
  if (cached && cached.exp - 300_000 > Date.now()) return cached.token;
  const jwt = await appJwt(env.GITHUB_APP_ID, env.GITHUB_APP_PRIVATE_KEY);
  const res = await f(`${env.GITHUB_API ?? 'https://api.github.com'}/app/installations/${id}/access_tokens`, {
    method: 'POST',
    headers: { authorization: `Bearer ${jwt}`, accept: 'application/vnd.github+json', 'user-agent': 'nitrogen', 'x-github-api-version': '2022-11-28' },
  });
  if (!res.ok) throw new GitHubError(res.status, `Could not mint an installation token (${res.status}).`, await res.text());
  const data = (await res.json()) as { token: string; expires_at: string };
  tokenCache.set(id, { token: data.token, exp: Date.parse(data.expires_at) });
  return data.token;
}

export class GitHubClient {
  readonly api: string;
  readonly base: string;
  /** Number of HTTP calls made (for subrequest budgeting and tests). */
  calls = 0;

  constructor(
    private env: Env,
    private f: typeof fetch = env.GITHUB_FETCH ?? fetch.bind(globalThis),
  ) {
    this.api = env.GITHUB_API ?? 'https://api.github.com';
    this.base = `${this.api}/repos/${env.GITHUB_OWNER}/${env.GITHUB_REPO}`;
  }

  async request<T>(method: string, path: string, body?: unknown, extraHeaders: Record<string, string> = {}): Promise<{ status: number; data: T; headers: Headers }> {
    const token = await installationToken(this.env, this.f);
    this.calls++;
    const res = await this.f(path.startsWith('http') ? path : `${this.base}${path}`, {
      method,
      headers: {
        authorization: `token ${token}`,
        accept: 'application/vnd.github+json',
        'user-agent': 'nitrogen',
        'x-github-api-version': '2022-11-28',
        ...(body !== undefined ? { 'content-type': 'application/json' } : {}),
        ...extraHeaders,
      },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    });
    if (res.status === 304) return { status: 304, data: null as T, headers: res.headers };
    const text = await res.text();
    let data: unknown = null;
    try {
      data = text ? JSON.parse(text) : null;
    } catch {
      data = text;
    }
    if (!res.ok) {
      const msg = (data as { message?: string } | null)?.message ?? res.statusText;
      throw new GitHubError(res.status, `GitHub ${method} ${path} failed: ${res.status} ${msg}`, data);
    }
    return { status: res.status, data: data as T, headers: res.headers };
  }

  async getHead(branch: string, etag?: string): Promise<{ sha: string | null; etag: string | null }> {
    const r = await this.request<{ object: { sha: string } }>('GET', `/git/ref/heads/${encodeURIComponent(branch)}`, undefined, etag ? { 'if-none-match': etag } : {});
    if (r.status === 304) return { sha: null, etag: etag ?? null };
    return { sha: r.data.object.sha, etag: r.headers.get('etag') };
  }

  async getCommit(sha: string): Promise<CommitInfo> {
    return (await this.request<CommitInfo>('GET', `/git/commits/${sha}`)).data;
  }

  async getTree(sha: string): Promise<{ sha: string; tree: TreeItem[]; truncated: boolean }> {
    return (await this.request<{ sha: string; tree: TreeItem[]; truncated: boolean }>('GET', `/git/trees/${sha}?recursive=1`)).data;
  }

  async getBlob(sha: string): Promise<Uint8Array> {
    const r = await this.request<{ content: string; encoding: string }>('GET', `/git/blobs/${sha}`);
    return r.data.encoding === 'base64' ? b64Decode(r.data.content) : new TextEncoder().encode(r.data.content);
  }

  async createBlob(bytes: Uint8Array): Promise<string> {
    return (await this.request<{ sha: string }>('POST', '/git/blobs', { content: b64Encode(bytes), encoding: 'base64' })).data.sha;
  }

  async createTree(baseTree: string, entries: { path: string; mode: '100644'; type: 'blob'; sha?: string | null; content?: string }[]): Promise<string> {
    return (await this.request<{ sha: string }>('POST', '/git/trees', { base_tree: baseTree, tree: entries })).data.sha;
  }

  async createCommit(message: string, tree: string, parents: string[], author?: { name: string; email: string }): Promise<CommitInfo> {
    return (await this.request<CommitInfo>('POST', '/git/commits', { message, tree, parents, ...(author ? { author } : {}) })).data;
  }

  /** Fast-forward a branch. Throws GitHubError(422) when the update is not a fast-forward. */
  async updateRef(branch: string, sha: string): Promise<void> {
    await this.request('PATCH', `/git/refs/heads/${encodeURIComponent(branch)}`, { sha, force: false });
  }

  async compare(base: string, head: string): Promise<{ files: CommitFile[]; status: string }> {
    return (await this.request<{ files?: CommitFile[]; status: string }>('GET', `/compare/${base}...${head}`)).data as { files: CommitFile[]; status: string };
  }

  async listCommits(opts: { path?: string; sha?: string; perPage?: number }): Promise<ListedCommit[]> {
    const q = new URLSearchParams();
    if (opts.path) q.set('path', opts.path);
    if (opts.sha) q.set('sha', opts.sha);
    q.set('per_page', String(opts.perPage ?? 30));
    return (await this.request<ListedCommit[]>('GET', `/commits?${q}`)).data;
  }

  async getCommitWithFiles(sha: string): Promise<ListedCommit & { files: CommitFile[] }> {
    return (await this.request<ListedCommit & { files: CommitFile[] }>('GET', `/commits/${sha}`)).data;
  }
}
