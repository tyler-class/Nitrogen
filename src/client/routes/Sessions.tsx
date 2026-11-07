// AI Sessions: the log of what assistants did, outside the page tree. Entries are written by the
// server (see worker/sessions.ts) and are read-only here; the owner can purge one.
import { useMemo, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Link, useNavigate, useParams } from 'react-router';
import { actorLabel } from '@shared/actor';
import type { PageDetail, SessionEntry } from '@shared/types';
import { api, ApiError, errorMessage } from '../lib/api';
import { formatDay, formatTime } from '../lib/activity';
import { keys } from '../lib/queries';
import { Chips } from '../components/charts';
import { Icon } from '../components/Icon';
import { Markdown } from '../components/Markdown';
import { useToast } from '../components/Toast';
import { useTitleIndex } from './PageView';

export function useSessions() {
  return useQuery({
    queryKey: ['sessions'],
    queryFn: () => api.get<{ root_id: string | null; entries: SessionEntry[] }>('/sessions'),
    staleTime: 30_000,
  });
}

const timeRange = (e: SessionEntry) => {
  const a = formatTime(e.started_at);
  const b = formatTime(e.ended_at);
  return a === b ? a : `${a}–${b}`;
};

export function Sessions() {
  const { id } = useParams<{ id?: string }>();
  return id ? <SessionView id={id} /> : <SessionLog />;
}

function SessionLog() {
  const q = useSessions();
  const [who, setWho] = useState('all');
  const entries = q.data?.entries ?? [];
  const actors = useMemo(
    () => [...new Set(entries.map((e) => e.actor ?? ''))].filter(Boolean),
    [entries],
  );
  const shown = entries.filter((e) => who === 'all' || e.actor === who);

  return (
    <div className="page sessions">
      <h1 className="page-title">AI Sessions</h1>
      <p className="sessions-sub">What assistants did in your wiki, recorded automatically.</p>
      {actors.length > 1 && (
        <Chips
          label="Assistant"
          options={[['all', 'All'], ...actors.map((a) => [a, actorLabel(a)] as const)]}
          value={who}
          onChange={setWho}
        />
      )}
      {q.isPending && <p className="muted">Loading…</p>}
      {q.data && !shown.length && <p className="muted">No sessions yet.</p>}
      {shown.map((e, i) => {
        const day = formatDay(e.started_at);
        const showDay = i === 0 || day !== formatDay(shown[i - 1]!.started_at);
        return (
          <div key={e.id}>
            {showDay && <h2 className="act-day">{day}</h2>}
            <Link to={`/sessions/${e.id}`} className="session-card">
              <div className="session-when">{timeRange(e)}</div>
              <div className="session-main">
                <div className="session-title">
                  <span>{e.title}</span>
                  <span className="session-who">{actorLabel(e.actor)}</span>
                </div>
                {e.summary && <p className="session-summary">{e.summary}</p>}
                <div className="session-meta">
                  {e.pages} page{e.pages === 1 ? '' : 's'} touched
                  {e.open_items > 0 &&
                    ` · ${e.open_items} open item${e.open_items === 1 ? '' : 's'}`}
                </div>
              </div>
              <Icon name="chevron" size={14} />
            </Link>
          </div>
        );
      })}
    </div>
  );
}

function SessionView({ id }: { id: string }) {
  const list = useSessions();
  const page = useQuery({
    queryKey: keys.page(id),
    queryFn: () => api.get<PageDetail>(`/pages/${id}`),
  });
  const { index } = useTitleIndex();
  const qc = useQueryClient();
  const navigate = useNavigate();
  const toast = useToast();
  const entry = list.data?.entries.find((e) => e.id === id);

  async function purge() {
    if (!window.confirm(`Purge “${entry?.title ?? 'this session'}”? It’s removed for good.`))
      return;
    try {
      await api.del(`/sessions/${id}`);
      qc.removeQueries({ queryKey: keys.page(id) });
      await qc.invalidateQueries({ queryKey: ['sessions'] });
      void qc.invalidateQueries({ queryKey: keys.tree });
      navigate('/sessions', { replace: true });
    } catch (e) {
      toast(errorMessage(e));
    }
  }

  if (page.error)
    return (
      <div className="page-missing">
        <h1>
          {page.error instanceof ApiError && page.error.status === 404
            ? 'Session not found'
            : 'Could not load this session'}
        </h1>
        <Link to="/sessions">Back to AI Sessions</Link>
      </div>
    );
  if (!page.data) return <div className="page-loading" aria-busy="true" />;

  const body = page.data.page.body;
  return (
    <article className="page sessions">
      <div className="page-top">
        <nav className="crumbs" aria-label="Breadcrumb">
          <Link to="/sessions">
            <Icon name="sparkle" size={13} /> AI Sessions
          </Link>
        </nav>
        <div className="page-actions">
          <button className="btn" onClick={purge}>
            <Icon name="trash" size={15} /> Purge
          </button>
        </div>
      </div>
      <header className="page-head">
        <h1 className="page-title">
          {entry?.title ?? page.data.page.title.replace(/^\d{4}-\d{2}-\d{2}\s*·\s*/, '')}
        </h1>
        {entry && (
          <p className="page-meta">
            <span className="session-who">{actorLabel(entry.actor)}</span>{' '}
            {formatDay(entry.started_at)}, {timeRange(entry)} · {entry.pages} page
            {entry.pages === 1 ? '' : 's'} touched
          </p>
        )}
        <p className="locked-note">
          <Icon name="lock" size={14} /> Recorded automatically. Read-only.
        </p>
      </header>
      <div className="prose">
        <Markdown
          source={body.replace(/\n_Recorded automatically for[^\n]*_\s*$/, '')}
          titles={index}
        />
      </div>
    </article>
  );
}
