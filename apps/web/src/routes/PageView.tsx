import { useEffect, useMemo, useRef, useState } from 'react';
import { Link, useNavigate } from '@tanstack/react-router';
import { useQueryClient } from '@tanstack/react-query';
import { usePage, useTree, useVaultContext } from '../api/hooks.ts';
import type { LinkGroup, PageResponse } from '../api/types.ts';
import { Markdown } from '../components/Markdown.tsx';
import { useRail } from '../components/Shell.tsx';
import { buildTree, crumbs, siblingsOf, type TreeNode } from '../lib/tree.ts';
import { Icon } from '../components/Icon.tsx';
import { db } from '../lib/db.ts';
import { saveDraft, flush } from '../lib/sync.ts';
import { ApiError } from '../api/client.ts';

export function relTime(iso: string | null | undefined): string {
  if (!iso) return '';
  const s = (Date.now() - Date.parse(iso)) / 1000;
  if (s < 60) return 'just now';
  if (s < 3600) return `${Math.round(s / 60)}m ago`;
  if (s < 86400) return `${Math.round(s / 3600)}h ago`;
  return new Date(iso).toLocaleDateString();
}

function highlight(ctx: string, text: string) {
  const i = text ? ctx.indexOf(text) : -1;
  if (i < 0) return ctx;
  return (
    <>
      {ctx.slice(0, i)}
      <mark>{text}</mark>
      {ctx.slice(i + text.length)}
    </>
  );
}

export function Backlinks({ groups, path }: { groups: LinkGroup[]; path: string }) {
  if (!groups.length) return <p style={{ color: 'var(--faint)', fontSize: 14 }}>No pages link here yet.</p>;
  return (
    <div>
      {groups.map((g) => (
        <div className="backlink-group" key={g.path}>
          <Link to="/p/$" params={{ _splat: g.path }}>{g.title ?? g.path}</Link>{' '}
          {g.count > 1 && <span className="chip">{g.count}</span>}
          {g.links.map((l, i) => (
            <p className="backlink-ctx" key={i}>
              {l.rel !== 'related' && <span className="chip rel" title={`Relation: ${l.rel}`}>{l.rel}</span>} {highlight(l.ctx, l.text)}
            </p>
          ))}
        </div>
      ))}
      <Link to="/links" search={{ page: path }} style={{ fontSize: 13 }}>Explore links →</Link>
    </div>
  );
}

function Outline({ items }: { items: PageResponse['outline'] }) {
  const list = items.filter((h) => h.level > 1 && h.level <= 4);
  if (!list.length) return null;
  return (
    <nav aria-label="Outline">
      <ul className="outline">
        {list.map((h) => (
          <li key={h.slug} style={{ paddingLeft: (h.level - 2) * 12 }}>
            <a href={`#${h.slug}`}>{h.text}</a>
          </li>
        ))}
      </ul>
    </nav>
  );
}

function PageInfo({ page }: { page: PageResponse }) {
  const m = page.meta;
  return (
    <dl style={{ display: 'grid', gridTemplateColumns: 'auto 1fr', gap: '4px 12px', margin: 0, color: 'var(--muted)' }}>
      <dt>Path</dt>
      <dd style={{ margin: 0, overflowWrap: 'anywhere' }}><code>/{page.path}</code></dd>
      {m?.updated_at && (<><dt>Updated</dt><dd style={{ margin: 0 }}>{m.updated_at}</dd></>)}
      {m?.last_actor && (<><dt>Last edit</dt><dd style={{ margin: 0 }}>{m.last_actor === 'claude' ? <span className="chip claude">Claude</span> : m.last_actor === 'human' ? 'You' : 'git'}</dd></>)}
      <dt>Blob</dt>
      <dd style={{ margin: 0 }}><code>{page.sha.slice(0, 7)}</code></dd>
      <dt>History</dt>
      <dd style={{ margin: 0 }}><Link to="/history" search={{ path: page.path }}>View history</Link></dd>
    </dl>
  );
}

function Subpages({ node }: { node: TreeNode }) {
  if (!node.children.length) return null;
  return (
    <section aria-label="Subpages">
      <h2 style={{ fontSize: 18 }}>Subpages</h2>
      <ul className="subpages">
        {node.children.map((c) => (
          <li key={c.id}>
            {c.page ? <Link to="/p/$" params={{ _splat: c.page }}>{c.title}</Link> : <span>{c.title}</span>}
          </li>
        ))}
      </ul>
    </section>
  );
}

export function PageView({ path }: { path: string }) {
  const page = usePage(path);
  const tree = useTree();
  const ctx = useVaultContext();
  const navigate = useNavigate();
  const qc = useQueryClient();
  const root = useMemo(() => (tree.data ? buildTree(tree.data.pages) : null), [tree.data]);
  const titleOf = (p: string) => tree.data?.pages.find((x) => x.path === p)?.title;
  const [updatedBy, setUpdatedBy] = useState<string | null>(null);
  const [hasDraft, setHasDraft] = useState(false);
  const lastSha = useRef<string | null>(null);

  useEffect(() => {
    void db.drafts.get(path).then((d) => setHasDraft(!!d));
  }, [path, page.data?.sha]);
  useEffect(() => {
    const sha = page.data?.sha ?? null;
    if (lastSha.current && sha && sha !== lastSha.current) setUpdatedBy(page.data?.meta?.last_actor === 'claude' ? 'Claude' : 'someone else');
    lastSha.current = sha;
  }, [page.data?.sha, page.data?.meta?.last_actor]);
  useEffect(() => {
    setUpdatedBy(null);
    lastSha.current = null;
  }, [path]);
  useEffect(() => {
    if (page.data) document.title = `${page.data.meta?.title ?? path} · Nitrogen`;
  }, [page.data, path]);
  // Scroll to the hash once content renders.
  useEffect(() => {
    if (!page.data || !location.hash) return;
    requestAnimationFrame(() => document.getElementById(decodeURIComponent(location.hash.slice(1)))?.scrollIntoView());
  }, [page.data]);

  const folderNode = useMemo(() => {
    if (!root || !(path === 'index.md' || path.endsWith('/index.md'))) return null;
    const id = path === 'index.md' ? '' : path.slice(0, -'/index.md'.length);
    const find = (n: TreeNode): TreeNode | null => (n.id === id && n.kind === 'folder' ? n : n.children.reduce<TreeNode | null>((a, c) => a ?? (c.kind === 'folder' ? find(c) : null), null));
    return find(root);
  }, [root, path]);
  const sib = root ? siblingsOf(root, path) : { prev: null, next: null };

  useRail(
    page.data ? (
      <>
        <section><h3>Outline</h3><Outline items={page.data.outline} /></section>
        <section><h3>Linked here <Link to="/links" search={{ page: path }} style={{ fontWeight: 400 }}>Explore</Link></h3><Backlinks groups={page.data.backlinks} path={path} /></section>
        <section><h3>Page info</h3><PageInfo page={page.data} /></section>
      </>
    ) : null,
    [page.data],
  );

  const onToggleTask = async (index: number, checked: boolean) => {
    if (!page.data) return;
    let n = -1;
    const next = page.data.content.replace(/^(\s*(?:[-+*]|\d+[.)])\s+)\[( |x|X)\]/gm, (m, lead: string) => (++n === index ? `${lead}[${checked ? 'x' : ' '}]` : m));
    const draft = await db.drafts.get(path);
    await saveDraft({ path, op: 'put', content: next, baseSha: draft?.baseSha ?? page.data.sha, base: draft?.base ?? page.data.content });
    qc.setQueryData(['page', path], { ...page.data, content: next });
    setTimeout(() => void flush(), 1500);
  };

  if (page.isLoading)
    return (
      <article className="page" aria-busy="true">
        <div className="skeleton-line" style={{ width: '30%' }} />
        <div className="skeleton-line" style={{ height: 34, width: '60%' }} />
        {[1, 2, 3, 4, 5, 6].map((i) => <div key={i} className="skeleton-line" style={{ width: `${70 + (i % 3) * 10}%` }} />)}
      </article>
    );
  if (page.isError) {
    const notFound = page.error instanceof ApiError && page.error.status === 404;
    return (
      <article className="page">
        <h1 className="page-title">{notFound ? 'Page not found' : 'Could not load the page'}</h1>
        <p>{notFound ? `There is no page at /${path}.` : (page.error as Error).message}</p>
        {notFound && <Link className="btn btn-primary" to="/new" search={{ path }}>Create it</Link>}
      </article>
    );
  }
  const p = page.data!;
  const m = p.meta;
  return (
    <article className="page">
      <nav className="crumbs" aria-label="Breadcrumb">
        {crumbs(path, titleOf).map((c, i) => (
          <span key={i}>
            {c.href ? <a href={c.href} onClick={(e) => { e.preventDefault(); void navigate({ to: c.href! }); }}>{c.label}</a> : c.label} /
          </span>
        ))}
      </nav>
      <div className="page-head">
        <h1 className="page-title">{m?.icon && [...m.icon].length <= 2 ? `${m.icon} ` : ''}{m?.title ?? path}</h1>
        <Link className="btn" to="/edit/$" params={{ _splat: path }} aria-label="Edit page"><Icon name="edit" size={14} /> Edit</Link>
      </div>
      <div className="meta-line">
        {m?.status && <span className={`chip status-${m.status}`}>{m.status}</span>}
        {m?.tags.map((t) => <Link key={t} className="chip" to="/search" search={{ q: `tag:${t}` }}>#{t}</Link>)}
        {m?.locked && <span className="chip">Locked</span>}
        {(p as { offline?: boolean }).offline && <span className="chip">Offline copy</span>}
        {updatedBy && <span className="pill-updated">Updated by {updatedBy} {relTime(new Date().toISOString())}</span>}
        {hasDraft && <Link className="chip status-draft" to="/edit/$" params={{ _splat: path }}>Unsaved draft</Link>}
      </div>
      <details className="rail-inline">
        <summary>Outline and links</summary>
        <div className="rail-body">
          <Outline items={p.outline} />
          <h3 style={{ fontSize: 13, color: 'var(--faint)' }}>Linked here</h3>
          <Backlinks groups={p.backlinks} path={path} />
        </div>
      </details>
      <Markdown src={p.content} path={path} ctx={ctx} onToggleTask={(i, c) => void onToggleTask(i, c)} />
      {folderNode && <Subpages node={folderNode} />}
      <footer className="page-footer">
        <h2 style={{ fontSize: 16 }}>Linked here</h2>
        <Backlinks groups={p.backlinks} path={path} />
        <nav className="prevnext" aria-label="Sibling pages">
          {sib.prev?.page ? <Link to="/p/$" params={{ _splat: sib.prev.page }}><small>Previous</small>{sib.prev.title}</Link> : <span />}
          {sib.next?.page ? <Link to="/p/$" params={{ _splat: sib.next.page }}><small>Next</small>{sib.next.title}</Link> : <span />}
        </nav>
      </footer>
    </article>
  );
}
