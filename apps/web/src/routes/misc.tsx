import { useEffect, useState } from 'react';
import { Link, useNavigate } from '@tanstack/react-router';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { api, qs } from '../api/client.ts';
import { useActivity, useMe, useTree } from '../api/hooks.ts';
import type { ActivityRow } from '../api/types.ts';
import { relTime } from './PageView.tsx';
import { applyTheme, getTheme, type Theme } from '../lib/theme.ts';
import { toast } from '../lib/toast.ts';
import { checkPagePath, titleFromName } from '@nitrogen/core';
import { saveDraft } from '../lib/sync.ts';

export function SearchView({ q }: { q: string }) {
  const navigate = useNavigate();
  const [text, setText] = useState(q);
  const r = useQuery({ queryKey: ['search', q], queryFn: () => api<{ results: { path: string; title: string; snippet: string; status?: string }[] }>(`/search${qs({ q, limit: 50 })}`), enabled: !!q });
  return (
    <div className="page">
      <h1 className="page-title">Search</h1>
      <form onSubmit={(e) => { e.preventDefault(); void navigate({ to: '/search', search: { q: text } }); }} role="search">
        <label className="sr-only" htmlFor="q">Search</label>
        <input id="q" className="input" value={text} onChange={(e) => setText(e.target.value)} placeholder="Words, or filters: under:architecture tag:sync status:draft" autoFocus />
      </form>
      {r.isLoading && <div className="skeleton-line" />}
      {r.data && (r.data.results.length === 0 ? <p className="empty">No results for “{q}”.</p> : (
        <ul className="list-plain">
          {r.data.results.map((x) => (
            <li key={x.path}>
              <Link to="/p/$" params={{ _splat: x.path }} style={{ fontWeight: 600 }}>{x.title}</Link> <small style={{ color: 'var(--faint)' }}>/{x.path}</small>
              {/* Snippets contain only <mark> from FTS5 around escaped index text. */}
              <p className="backlink-ctx" dangerouslySetInnerHTML={{ __html: escapeExceptMark(x.snippet ?? '') }} />
            </li>
          ))}
        </ul>
      ))}
    </div>
  );
}

export function escapeExceptMark(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/&lt;(\/?)mark&gt;/g, '<$1mark>');
}

export function ActorBadge({ actor }: { actor: ActivityRow['actor'] | string }) {
  if (actor === 'claude') return <span className="chip claude">Claude</span>;
  if (actor === 'human') return <span className="chip">You</span>;
  return <span className="chip">git</span>;
}

export function ActivityView() {
  const [actor, setActor] = useState<string | undefined>();
  const a = useActivity(actor);
  const qc = useQueryClient();
  const revert = async (sha: string) => {
    if (!confirm('Revert this commit? A new commit restores the previous versions.')) return;
    try {
      await api('/revert', { method: 'POST', json: { sha } });
      toast('Reverted.');
      await qc.invalidateQueries();
    } catch (e) {
      toast((e as Error).message);
    }
  };
  return (
    <div className="page">
      <h1 className="page-title">Activity</h1>
      <div className="toolbar" role="group" aria-label="Filter by actor">
        {[[undefined, 'All'], ['human', 'You'], ['claude', 'Claude'], ['external', 'git']].map(([v, l]) => (
          <button key={l} className="chip-toggle" aria-pressed={actor === v} onClick={() => setActor(v)}>{l}</button>
        ))}
      </div>
      {a.data?.activity.length === 0 && <p className="empty">No activity yet. Edit a page to make the first commit.</p>}
      <ul className="list-plain">
        {a.data?.activity.map((r) => (
          <li key={r.id}>
            <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
              <ActorBadge actor={r.actor} />
              <span style={{ fontWeight: 600 }}>{r.message}</span>
              <small style={{ color: 'var(--faint)', marginLeft: 'auto' }}>{relTime(r.at)}</small>
            </div>
            <div style={{ fontSize: 13, color: 'var(--muted)', display: 'flex', gap: 12, marginTop: 4 }}>
              {r.path && <Link to="/p/$" params={{ _splat: r.path }}>{r.path}</Link>}
              <span>{r.files} file{r.files === 1 ? '' : 's'}</span>
              <code>{r.sha.slice(0, 7)}</code>
              <Link to="/diff" search={{ sha: r.sha }}>View diff</Link>
              <button className="btn-danger" style={{ fontSize: 13 }} onClick={() => void revert(r.sha)}>Revert</button>
            </div>
          </li>
        ))}
      </ul>
    </div>
  );
}

export function SettingsView() {
  const me = useMe();
  const [theme, setTheme] = useState<Theme>(getTheme());
  const [profile, setProfile] = useState(() => localStorage.getItem('n2-profile') ?? 'gfm');
  const [font, setFont] = useState(() => localStorage.getItem('n2-editor-font') ?? '14');
  return (
    <div className="page">
      <h1 className="page-title">Settings</h1>
      <section>
        <h2 style={{ fontSize: 18 }}>Appearance</h2>
        <label>Theme{' '}
          <select className="input" style={{ width: 'auto' }} value={theme} onChange={(e) => { const t = e.target.value as Theme; setTheme(t); applyTheme(t); }}>
            <option value="system">Match system</option><option value="light">Light</option><option value="dark">Dark</option>
          </select>
        </label>{' '}
        <label>Editor font size{' '}
          <select className="input" style={{ width: 'auto' }} value={font} onChange={(e) => { setFont(e.target.value); localStorage.setItem('n2-editor-font', e.target.value); }}>
            {['13', '14', '15', '16', '18'].map((s) => <option key={s}>{s}</option>)}
          </select>
        </label>
      </section>
      <section>
        <h2 style={{ fontSize: 18 }}>Export</h2>
        <label>Default profile{' '}
          <select className="input" style={{ width: 'auto' }} value={profile} onChange={(e) => { setProfile(e.target.value); localStorage.setItem('n2-profile', e.target.value); }}>
            <option value="gfm">GFM (GitHub)</option><option value="commonmark">Strict CommonMark</option>
          </select>
        </label>
      </section>
      <section>
        <h2 style={{ fontSize: 18 }}>Claude (MCP)</h2>
        <p style={{ color: 'var(--muted)' }}>In claude.ai: Settings, Connectors, Add custom connector, then paste this URL and sign in with GitHub.</p>
        <div style={{ display: 'flex', gap: 8 }}>
          <input className="input" readOnly value={me.data?.mcpUrl ?? ''} aria-label="MCP URL" />
          <button className="btn" onClick={() => void navigator.clipboard.writeText(me.data?.mcpUrl ?? '').then(() => toast('Copied.'))}>Copy</button>
        </div>
      </section>
      <section>
        <h2 style={{ fontSize: 18 }}>Install on your phone</h2>
        <p style={{ color: 'var(--muted)' }}>iPhone: open this site in Safari, tap Share, then Add to Home Screen. Android: Chrome menu, Install app. Edits made offline are saved on the device and committed when you reconnect (open the app to sync; iOS has no background sync).</p>
      </section>
      <section>
        <h2 style={{ fontSize: 18 }}>Account</h2>
        <p style={{ color: 'var(--muted)' }}>{me.data ? `Signed in as ${me.data.user.login}. Repo ${me.data.repo} (${me.data.branch}). Nitrogen ${me.data.version}.` : ''}</p>
        <button className="btn" onClick={() => void fetch('/auth/logout', { method: 'POST' }).then(() => location.assign('/'))}>Sign out</button>
      </section>
    </div>
  );
}

export function BrokenView() {
  const r = useQuery({ queryKey: ['broken'], queryFn: () => api<{ links: { src: string; dst: string; text: string; line: number }[] }>('/broken') });
  return (
    <div className="page">
      <h1 className="page-title">Broken links</h1>
      {r.data?.links.length === 0 && <p className="empty">No broken links.</p>}
      <ul className="list-plain">
        {r.data?.links.map((l, i) => (
          <li key={i}><Link to="/p/$" params={{ _splat: l.src }}>{l.src}</Link> line {l.line}: “{l.text}” → <code>/{l.dst}</code> <Link to="/new" search={{ path: l.dst }}>Create page</Link></li>
        ))}
      </ul>
    </div>
  );
}

/** New page: pick a path and title; opens the editor with a draft. */
export function NewPageView({ dir, path: presetPath, title: presetTitle }: { dir?: string; path?: string; title?: string }) {
  const navigate = useNavigate();
  const tree = useTree();
  const [title, setTitle] = useState(presetTitle ?? '');
  const slug = title.toLowerCase().normalize('NFKD').replace(/[̀-ͯ]/g, '').replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
  const [path, setPath] = useState(presetPath ?? '');
  useEffect(() => {
    if (!presetPath) setPath(`${dir ? `${dir.replace(/\/$/, '')}/` : ''}${slug || 'untitled'}.md`);
  }, [slug, dir, presetPath]);
  useEffect(() => {
    if (presetPath && !presetTitle) setTitle(titleFromName(presetPath.split('/').pop()!));
  }, [presetPath, presetTitle]);
  const check = checkPagePath(path, tree.data ? ['.github', '.nitrogen', tree.data.config.assets_dir, 'node_modules'] : []);
  const exists = tree.data?.pages.some((p) => p.path === path);
  const create = async () => {
    await saveDraft({ path, op: 'put', baseSha: null, base: null, content: `# ${title || 'Untitled'}\n\n` });
    void navigate({ to: '/edit/$', params: { _splat: path } });
  };
  return (
    <div className="page">
      <h1 className="page-title">New page</h1>
      <form onSubmit={(e) => { e.preventDefault(); if (check.ok && !exists) void create(); }} style={{ display: 'grid', gap: 12 }}>
        <label>Title <input className="input" value={title} onChange={(e) => setTitle(e.target.value)} autoFocus /></label>
        <label>Path <input className="input" value={path} onChange={(e) => setPath(e.target.value)} /></label>
        {!check.ok && <p role="alert" style={{ color: 'var(--danger)' }}>{check.reason}</p>}
        {exists && <p role="alert" style={{ color: 'var(--danger)' }}>A page already exists at /{path}.</p>}
        <div><button className="btn btn-primary" disabled={!check.ok || exists}>Create page</button></div>
      </form>
    </div>
  );
}

export function MoveView({ path }: { path: string }) {
  const navigate = useNavigate();
  const qc = useQueryClient();
  const [to, setTo] = useState(path);
  const [busy, setBusy] = useState(false);
  const check = checkPagePath(to, ['.github', '.nitrogen', 'images', 'node_modules']);
  const move = async () => {
    setBusy(true);
    try {
      const r = await api<{ rewritten: string[] }>('/commit', { method: 'POST', json: { changes: [{ path, op: 'move', to }] } });
      toast(`Moved. ${r.rewritten.length} linking page${r.rewritten.length === 1 ? '' : 's'} updated.`);
      await qc.invalidateQueries();
      void navigate({ to: '/p/$', params: { _splat: to } });
    } catch (e) {
      toast((e as Error).message);
      setBusy(false);
    }
  };
  return (
    <div className="page">
      <h1 className="page-title">Rename or move</h1>
      <p style={{ color: 'var(--muted)' }}>Moving rewrites every link that points at /{path} in the same commit.</p>
      <form onSubmit={(e) => { e.preventDefault(); if (check.ok && to !== path) void move(); }} style={{ display: 'grid', gap: 12 }}>
        <label>New path <input className="input" value={to} onChange={(e) => setTo(e.target.value)} autoFocus /></label>
        {!check.ok && <p role="alert" style={{ color: 'var(--danger)' }}>{check.reason}</p>}
        <div><button className="btn btn-primary" disabled={!check.ok || to === path || busy}>Move page</button></div>
      </form>
    </div>
  );
}
