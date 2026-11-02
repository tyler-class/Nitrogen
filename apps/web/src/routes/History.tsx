import { useState } from 'react';
import { Link, useNavigate } from '@tanstack/react-router';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { api, qs } from '../api/client.ts';
import { relTime } from './PageView.tsx';
import { ActorBadge } from './misc.tsx';
import { toast } from '../lib/toast.ts';
import { diffLines } from '../lib/diff.ts';

export function DiffBlock({ before, after }: { before: string; after: string }) {
  const lines = diffLines(before, after);
  return (
    <pre style={{ fontSize: 13, background: 'var(--code-bg)', padding: 12, borderRadius: 8, overflowX: 'auto' }} aria-label="Changes">
      {lines.map((l, i) => (
        <div key={i} style={{ background: l.t === '+' ? 'var(--ok-soft)' : l.t === '-' ? 'var(--danger-soft)' : undefined }}>
          <span aria-hidden style={{ color: 'var(--faint)', userSelect: 'none' }}>{l.t === ' ' ? ' ' : l.t} </span>
          <span className="sr-only">{l.t === '+' ? 'added: ' : l.t === '-' ? 'removed: ' : ''}</span>
          {l.s || ' '}
        </div>
      ))}
    </pre>
  );
}

export function HistoryView({ path }: { path: string }) {
  const q = useQuery({ queryKey: ['history', path], queryFn: () => api<{ commits: { sha: string; message: string; author: string; at: string; actor: string }[] }>(`/history${qs({ path })}`) });
  const [sel, setSel] = useState<string | null>(null);
  const navigate = useNavigate();
  const qc = useQueryClient();
  const version = useQuery({ queryKey: ['version', path, sel], queryFn: () => api<{ content: string; sha: string }>(`/version${qs({ path, sha: sel })}`), enabled: !!sel });
  const current = useQuery({ queryKey: ['page', path, 'raw'], queryFn: () => api<{ content: string; sha: string }>(`/page${qs({ path, include: 'content' })}`) });
  const restore = async () => {
    if (!version.data || !current.data) return;
    try {
      await api('/commit', { method: 'POST', json: { changes: [{ path, op: 'put', content: version.data.content, baseSha: current.data.sha }], message: `nitrogen: restore ${path} to ${sel!.slice(0, 7)}` } });
      toast('Restored. 1 file committed.');
      await qc.invalidateQueries();
      void navigate({ to: '/p/$', params: { _splat: path } });
    } catch (e) {
      toast((e as Error).message);
    }
  };
  return (
    <div className="page">
      <h1 className="page-title">History</h1>
      <p><Link to="/p/$" params={{ _splat: path }}>/{path}</Link></p>
      <ul className="list-plain">
        {q.data?.commits.map((c) => (
          <li key={c.sha}>
            <button style={{ textAlign: 'left', width: '100%' }} onClick={() => setSel(c.sha)} aria-pressed={sel === c.sha}>
              <ActorBadge actor={c.actor} /> <strong>{c.message}</strong> <small style={{ color: 'var(--faint)' }}>{c.author}, {relTime(c.at)} · {c.sha.slice(0, 7)}</small>
            </button>
          </li>
        ))}
      </ul>
      {sel && version.data && current.data && (
        <section>
          <h2 style={{ fontSize: 18 }}>Changes since {sel.slice(0, 7)}</h2>
          <DiffBlock before={version.data.content} after={current.data.content} />
          <button className="btn btn-primary" onClick={() => void restore()} disabled={version.data.sha === current.data.sha}>Restore this version</button>
        </section>
      )}
    </div>
  );
}

export function DiffView({ sha }: { sha: string }) {
  const q = useQuery({
    queryKey: ['diff', sha],
    queryFn: async () => {
      const act = await api<{ activity: { sha: string; path: string | null; message: string }[] }>('/activity?limit=200');
      return act.activity.find((a) => a.sha === sha) ?? null;
    },
  });
  return (
    <div className="page">
      <h1 className="page-title">Commit {sha.slice(0, 7)}</h1>
      <p>{q.data?.message}</p>
      {q.data?.path && <Link to="/history" search={{ path: q.data.path }}>Open history of /{q.data.path}</Link>}
    </div>
  );
}
