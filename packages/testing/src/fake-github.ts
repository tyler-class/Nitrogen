/**
 * In-memory fake of the GitHub REST endpoints Nitrogen uses. Object ids are real git SHA-1s, so
 * blob shas match `git hash-object`. Use `fake.fetch` wherever a `fetch` is injected.
 */
import { sha1Hex } from './sha1.ts';

const enc = new TextEncoder();
const dec = new TextDecoder();

type Obj =
  | { type: 'blob'; data: Uint8Array }
  | { type: 'tree'; entries: TreeEntry[] }
  | { type: 'commit'; tree: string; parents: string[]; message: string; author: Person; committer: Person };

interface TreeEntry {
  name: string;
  mode: string;
  type: 'blob' | 'tree';
  sha: string;
}

interface Person {
  name: string;
  email: string;
  date: string;
}

function concat(...parts: Uint8Array[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let o = 0;
  for (const p of parts) {
    out.set(p, o);
    o += p.length;
  }
  return out;
}

function hexToBytes(hex: string): Uint8Array {
  const b = new Uint8Array(hex.length / 2);
  for (let i = 0; i < b.length; i++) b[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  return b;
}

export function toBase64(bytes: Uint8Array): string {
  let s = '';
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s);
}

export function fromBase64(b64: string): Uint8Array {
  const s = atob(b64.replace(/\s/g, ''));
  const out = new Uint8Array(s.length);
  for (let i = 0; i < s.length; i++) out[i] = s.charCodeAt(i);
  return out;
}

export interface FakeGitHubOptions {
  owner?: string;
  repo?: string;
  branch?: string;
  installationId?: number;
  users?: { id: number; login: string; name?: string }[];
  files?: Record<string, string | Uint8Array>;
}

export interface RecordedRequest {
  method: string;
  path: string;
  body: unknown;
}

export class FakeGitHub {
  readonly owner: string;
  readonly repo: string;
  readonly branch: string;
  readonly installationId: number;
  objects = new Map<string, Obj>();
  refs = new Map<string, string>();
  requests: RecordedRequest[] = [];
  users: { id: number; login: string; name?: string }[];
  /** OAuth codes -> user id. */
  oauthCodes = new Map<string, number>();
  tokens = new Map<string, number>();
  /** Called right before a ref update is applied; use it to simulate a concurrent push. */
  beforeRefUpdate: (() => void) | null = null;
  /** Manifest conversion codes -> response. */
  manifestConversions = new Map<string, Record<string, unknown>>();
  installations: { id: number; account: { login: string }; repositories: string[] }[] = [];
  clock = Date.parse('2026-11-02T12:00:00Z');

  constructor(opts: FakeGitHubOptions = {}) {
    this.owner = opts.owner ?? 'octo';
    this.repo = opts.repo ?? 'notes';
    this.branch = opts.branch ?? 'main';
    this.installationId = opts.installationId ?? 42;
    this.users = opts.users ?? [{ id: 1001, login: 'octo', name: 'Octo Cat' }];
    this.installations = [{ id: this.installationId, account: { login: this.owner }, repositories: [this.repo] }];
    const files = opts.files ?? { 'index.md': '# Home\n' };
    const tree = this.writeTreeFromFlat(new Map(Object.entries(files).map(([p, c]) => [p, this.writeBlob(typeof c === 'string' ? enc.encode(c) : c)])));
    const commit = this.writeCommit(tree, [], 'Initial commit');
    this.refs.set(this.branch, commit);
  }

  // ---------- object store ----------

  private store(type: string, body: Uint8Array, obj: Obj): string {
    const sha = sha1Hex(concat(enc.encode(`${type} ${body.length}\0`), body));
    this.objects.set(sha, obj);
    return sha;
  }

  writeBlob(data: Uint8Array): string {
    return this.store('blob', data, { type: 'blob', data });
  }

  writeTree(entries: TreeEntry[]): string {
    const sorted = [...entries].sort((a, b) => {
      const ka = a.type === 'tree' ? `${a.name}/` : a.name;
      const kb = b.type === 'tree' ? `${b.name}/` : b.name;
      return ka < kb ? -1 : ka > kb ? 1 : 0;
    });
    const body = concat(...sorted.map((e) => concat(enc.encode(`${e.mode === '040000' ? '40000' : e.mode} ${e.name}\0`), hexToBytes(e.sha))));
    return this.store('tree', body, { type: 'tree', entries: sorted });
  }

  writeCommit(tree: string, parents: string[], message: string, author?: Person): string {
    const who = author ?? { name: 'Nitrogen', email: 'bot@nitrogen.dev', date: new Date((this.clock += 1000)).toISOString() };
    const ts = Math.floor(Date.parse(who.date) / 1000);
    const body = enc.encode(
      `tree ${tree}\n${parents.map((p) => `parent ${p}\n`).join('')}author ${who.name} <${who.email}> ${ts} +0000\ncommitter ${who.name} <${who.email}> ${ts} +0000\n\n${message}`,
    );
    return this.store('commit', body, { type: 'commit', tree, parents, message, author: who, committer: who });
  }

  /** Flatten a tree into path -> blob sha. */
  flatten(treeSha: string, prefix = ''): Map<string, string> {
    const out = new Map<string, string>();
    const t = this.objects.get(treeSha);
    if (!t || t.type !== 'tree') throw new Error(`not a tree: ${treeSha}`);
    for (const e of t.entries) {
      const p = prefix ? `${prefix}/${e.name}` : e.name;
      if (e.type === 'tree') for (const [k, v] of this.flatten(e.sha, p)) out.set(k, v);
      else out.set(p, e.sha);
    }
    return out;
  }

  writeTreeFromFlat(flat: Map<string, string>): string {
    const root: Record<string, unknown> = {};
    for (const [path, sha] of flat) {
      const segs = path.split('/');
      let node = root;
      for (const s of segs.slice(0, -1)) node = (node[s] ??= {}) as Record<string, unknown>;
      node[segs[segs.length - 1]!] = sha;
    }
    const build = (node: Record<string, unknown>): string =>
      this.writeTree(
        Object.entries(node).map(([name, v]) =>
          typeof v === 'string' ? { name, mode: '100644', type: 'blob' as const, sha: v } : { name, mode: '040000', type: 'tree' as const, sha: build(v as Record<string, unknown>) },
        ),
      );
    return build(root);
  }

  // ---------- helpers for tests ----------

  head(): string {
    return this.refs.get(this.branch)!;
  }

  commitObj(sha: string): Extract<Obj, { type: 'commit' }> {
    const c = this.objects.get(sha);
    if (!c || c.type !== 'commit') throw new Error(`not a commit: ${sha}`);
    return c;
  }

  files(ref = this.head()): Map<string, string> {
    return this.flatten(this.commitObj(ref).tree);
  }

  read(path: string, ref = this.head()): string | null {
    const sha = this.files(ref).get(path);
    if (!sha) return null;
    const b = this.objects.get(sha)!;
    return b.type === 'blob' ? dec.decode(b.data) : null;
  }

  /** Simulate a push from elsewhere (e.g. git on a laptop). */
  push(changes: Record<string, string | null>, message = 'External change'): string {
    const flat = this.files();
    for (const [p, c] of Object.entries(changes)) {
      if (c === null) flat.delete(p);
      else flat.set(p, this.writeBlob(enc.encode(c)));
    }
    const commit = this.writeCommit(this.writeTreeFromFlat(flat), [this.head()], message);
    this.refs.set(this.branch, commit);
    return commit;
  }

  log(ref = this.head()): string[] {
    const out: string[] = [];
    let cur: string | undefined = ref;
    while (cur) {
      out.push(cur);
      cur = this.commitObj(cur).parents[0];
    }
    return out;
  }

  isAncestor(anc: string, desc: string): boolean {
    const seen = new Set<string>();
    const stack = [desc];
    while (stack.length) {
      const c = stack.pop()!;
      if (c === anc) return true;
      if (seen.has(c)) continue;
      seen.add(c);
      stack.push(...this.commitObj(c).parents);
    }
    return false;
  }

  grantUser(id: number, code: string): void {
    this.oauthCodes.set(code, id);
  }

  // ---------- HTTP ----------

  fetch = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const req = new Request(input, init);
    const url = new URL(req.url);
    let body: unknown = null;
    if (req.method !== 'GET' && req.method !== 'HEAD') {
      const text = await req.text();
      try {
        body = text ? JSON.parse(text) : null;
      } catch {
        body = Object.fromEntries(new URLSearchParams(text));
      }
    }
    this.requests.push({ method: req.method, path: url.pathname + url.search, body });
    try {
      return this.route(req, url, body);
    } catch (e) {
      return json({ message: (e as Error).message }, 500);
    }
  };

  private repoPrefix(): string {
    return `/repos/${this.owner}/${this.repo}`;
  }

  private route(req: Request, url: URL, body: unknown): Response {
    const p = url.pathname;
    const m = req.method;
    if (url.hostname === 'github.com' && p === '/login/oauth/access_token' && m === 'POST') {
      const b = body as Record<string, string>;
      const uid = this.oauthCodes.get(b.code ?? '');
      if (!uid) return json({ error: 'bad_verification_code' });
      this.oauthCodes.delete(b.code!);
      const token = `ghu_${uid}_${Math.random().toString(36).slice(2)}`;
      this.tokens.set(token, uid);
      return json({ access_token: token, token_type: 'bearer', scope: '' });
    }
    if (p === '/user' && m === 'GET') {
      const tok = (req.headers.get('authorization') ?? '').replace(/^(Bearer|token)\s+/i, '');
      const uid = this.tokens.get(tok);
      const u = this.users.find((x) => x.id === uid);
      if (!u) return json({ message: 'Bad credentials' }, 401);
      return json({ id: u.id, login: u.login, name: u.name ?? u.login, avatar_url: `https://avatars.example/${u.id}` });
    }
    if (p.startsWith('/app-manifests/') && p.endsWith('/conversions') && m === 'POST') {
      const code = p.split('/')[2]!;
      const r = this.manifestConversions.get(code);
      return r ? json(r, 201) : json({ message: 'Not Found' }, 404);
    }
    if (p === '/app/installations' && m === 'GET') {
      if (!/^Bearer ey/.test(req.headers.get('authorization') ?? '')) return json({ message: 'A JSON web token could not be decoded' }, 401);
      return json(this.installations.map((i) => ({ id: i.id, account: i.account, permissions: { contents: 'write', metadata: 'read' } })));
    }
    const tokM = /^\/app\/installations\/(\d+)\/access_tokens$/.exec(p);
    if (tokM && m === 'POST') {
      if (!/^Bearer ey/.test(req.headers.get('authorization') ?? '')) return json({ message: 'A JSON web token could not be decoded' }, 401);
      if (Number(tokM[1]) !== this.installationId) return json({ message: 'Not Found' }, 404);
      return json({ token: `ghs_fake_${Math.random().toString(36).slice(2)}`, expires_at: new Date(Date.now() + 3600_000).toISOString() }, 201);
    }
    if (p === '/installation/repositories') return json({ total_count: 1, repositories: [{ name: this.repo, full_name: `${this.owner}/${this.repo}` }] });

    const rp = this.repoPrefix();
    if (!p.startsWith(rp)) return json({ message: 'Not Found' }, 404);
    if (!/^(token|Bearer) ghs_/.test(req.headers.get('authorization') ?? '')) return json({ message: 'Bad credentials' }, 401);
    const sub = p.slice(rp.length);

    if (sub === '' && m === 'GET') return json({ name: this.repo, full_name: `${this.owner}/${this.repo}`, default_branch: this.branch, private: true });

    let mm: RegExpExecArray | null;
    if ((mm = /^\/git\/ref\/heads\/(.+)$/.exec(sub)) && m === 'GET') {
      const sha = this.refs.get(decodeURIComponent(mm[1]!));
      if (!sha) return json({ message: 'Not Found' }, 404);
      const etag = `"${sha}"`;
      if (req.headers.get('if-none-match') === etag) return new Response(null, { status: 304, headers: { etag } });
      return json({ ref: `refs/heads/${mm[1]}`, object: { sha, type: 'commit' } }, 200, { etag });
    }
    if ((mm = /^\/git\/refs\/heads\/(.+)$/.exec(sub)) && m === 'PATCH') {
      const b = body as { sha: string; force?: boolean };
      const name = decodeURIComponent(mm[1]!);
      this.beforeRefUpdate?.();
      this.beforeRefUpdate = null;
      const cur = this.refs.get(name);
      if (!cur) return json({ message: 'Reference does not exist' }, 422);
      if (!b.force && !this.isAncestor(cur, b.sha)) return json({ message: 'Update is not a fast forward' }, 422);
      this.refs.set(name, b.sha);
      return json({ ref: `refs/heads/${name}`, object: { sha: b.sha, type: 'commit' } });
    }
    if ((mm = /^\/git\/commits\/([0-9a-f]{40})$/.exec(sub)) && m === 'GET') {
      const c = this.objects.get(mm[1]!);
      if (!c || c.type !== 'commit') return json({ message: 'Not Found' }, 404);
      return json(this.commitJson(mm[1]!));
    }
    if (sub === '/git/commits' && m === 'POST') {
      const b = body as { message: string; tree: string; parents: string[]; author?: Person };
      if (!this.objects.has(b.tree)) return json({ message: 'Tree SHA does not exist' }, 422);
      for (const par of b.parents) if (!this.objects.has(par)) return json({ message: 'Parent SHA does not exist' }, 422);
      const sha = this.writeCommit(b.tree, b.parents, b.message, b.author);
      return json(this.commitJson(sha), 201);
    }
    if ((mm = /^\/git\/trees\/([0-9a-f]{40})$/.exec(sub)) && m === 'GET') {
      const t = this.objects.get(mm[1]!);
      if (!t || t.type !== 'tree') return json({ message: 'Not Found' }, 404);
      if (url.searchParams.get('recursive')) {
        const entries: unknown[] = [];
        const walk = (sha: string, prefix: string) => {
          const tt = this.objects.get(sha) as Extract<Obj, { type: 'tree' }>;
          for (const e of tt.entries) {
            const path = prefix ? `${prefix}/${e.name}` : e.name;
            const o = this.objects.get(e.sha)!;
            entries.push({ path, mode: e.mode, type: e.type, sha: e.sha, ...(o.type === 'blob' ? { size: o.data.length } : {}) });
            if (e.type === 'tree') walk(e.sha, path);
          }
        };
        walk(mm[1]!, '');
        return json({ sha: mm[1], tree: entries, truncated: false });
      }
      return json({ sha: mm[1], tree: t.entries.map((e) => ({ path: e.name, mode: e.mode, type: e.type, sha: e.sha })), truncated: false });
    }
    if (sub === '/git/trees' && m === 'POST') {
      const b = body as { base_tree?: string; tree: { path: string; mode: string; type: string; sha?: string | null; content?: string }[] };
      const flat = b.base_tree ? this.flatten(b.base_tree) : new Map<string, string>();
      for (const e of b.tree) {
        if (e.sha === null) {
          if (!flat.has(e.path)) {
            // GitHub returns 422 when deleting a path that does not exist.
            return json({ message: `GitRPC::BadObjectState: ${e.path}` }, 422);
          }
          flat.delete(e.path);
        } else if (e.content !== undefined) flat.set(e.path, this.writeBlob(enc.encode(e.content)));
        else if (e.sha) {
          if (!this.objects.has(e.sha)) return json({ message: 'Invalid sha' }, 422);
          flat.set(e.path, e.sha);
        }
      }
      const sha = this.writeTreeFromFlat(flat);
      return json({ sha, tree: [], truncated: false }, 201);
    }
    if ((mm = /^\/git\/blobs\/([0-9a-f]{40})$/.exec(sub)) && m === 'GET') {
      const bl = this.objects.get(mm[1]!);
      if (!bl || bl.type !== 'blob') return json({ message: 'Not Found' }, 404);
      return json({ sha: mm[1], size: bl.data.length, encoding: 'base64', content: toBase64(bl.data) });
    }
    if (sub === '/git/blobs' && m === 'POST') {
      const b = body as { content: string; encoding?: string };
      const data = b.encoding === 'base64' ? fromBase64(b.content) : enc.encode(b.content);
      return json({ sha: this.writeBlob(data) }, 201);
    }
    if ((mm = /^\/compare\/([0-9a-f]{40})\.\.\.([0-9a-f]{40})$/.exec(sub)) && m === 'GET') {
      const [, base, headSha] = mm;
      if (!this.objects.has(base!) || !this.objects.has(headSha!)) return json({ message: 'Not Found' }, 404);
      return json({ status: base === headSha ? 'identical' : 'ahead', files: this.diff(base!, headSha!), commits: [] });
    }
    if (sub === '/commits' && m === 'GET') {
      const path = url.searchParams.get('path');
      const start = url.searchParams.get('sha') ?? this.head();
      const per = Number(url.searchParams.get('per_page') ?? 30);
      const out: unknown[] = [];
      for (const c of this.log(this.refs.get(start) ?? start)) {
        const co = this.commitObj(c);
        const parent = co.parents[0];
        if (path) {
          const now = this.flatten(co.tree).get(path);
          const before = parent ? this.flatten(this.commitObj(parent).tree).get(path) : undefined;
          if (now === before) continue;
        }
        out.push({ sha: c, commit: { message: co.message, author: co.author, committer: co.committer }, parents: co.parents.map((s) => ({ sha: s })) });
        if (out.length >= per) break;
      }
      return json(out);
    }
    if ((mm = /^\/commits\/([0-9a-f]{40})$/.exec(sub)) && m === 'GET') {
      const co = this.objects.get(mm[1]!);
      if (!co || co.type !== 'commit') return json({ message: 'Not Found' }, 404);
      const parent = co.parents[0];
      return json({
        sha: mm[1],
        commit: { message: co.message, author: co.author },
        parents: co.parents.map((s) => ({ sha: s })),
        files: parent ? this.diff(parent, mm[1]!) : [...this.flatten(co.tree)].map(([filename, sha]) => ({ filename, sha, status: 'added' })),
      });
    }
    return json({ message: `Fake GitHub: no route for ${m} ${sub}` }, 404);
  }

  private diff(a: string, b: string): { filename: string; status: string; sha: string | null; previous_sha?: string | null }[] {
    const fa = this.flatten(this.commitObj(a).tree);
    const fb = this.flatten(this.commitObj(b).tree);
    const out: { filename: string; status: string; sha: string | null; previous_sha?: string | null }[] = [];
    for (const [p, s] of fb) {
      if (!fa.has(p)) out.push({ filename: p, status: 'added', sha: s, previous_sha: null });
      else if (fa.get(p) !== s) out.push({ filename: p, status: 'modified', sha: s, previous_sha: fa.get(p)! });
    }
    for (const [p, s] of fa) if (!fb.has(p)) out.push({ filename: p, status: 'removed', sha: null, previous_sha: s });
    return out.sort((x, y) => x.filename.localeCompare(y.filename));
  }

  private commitJson(sha: string) {
    const c = this.commitObj(sha);
    return { sha, tree: { sha: c.tree }, parents: c.parents.map((s) => ({ sha: s })), message: c.message, author: c.author, committer: c.committer };
  }
}

function json(data: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(data), { status, headers: { 'content-type': 'application/json', ...headers } });
}
