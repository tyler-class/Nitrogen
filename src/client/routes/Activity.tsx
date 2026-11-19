import { useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Link, useSearchParams } from 'react-router';
import { actorLabel, isAgent } from '@shared/actor';
import { pageHref } from '@shared/markdown';
import type { RevertResult, Session } from '@shared/types';
import { api, errorMessage } from '../lib/api';
import { eventVerb, formatDay, formatTime } from '../lib/activity';
import { keys } from '../lib/queries';
import { Icon } from '../components/Icon';
import { WhoToggle } from '../components/charts';
import { useToast } from '../components/Toast';

type Filter = 'all' | 'you' | 'agents';

export function Activity() {
  // "Assistant changes" notifications open /activity?who=agents&from=…&to=… (their hour).
  const [params, setParams] = useSearchParams();
  // The filter lives in the URL (?who=), so the toggle always matches what's listed, however
  // you got here (Home's "View all", a notification, back and forward).
  const w = params.get('who');
  const filter: Filter = w === 'agents' || w === 'you' ? w : 'all';
  const setFilter = (f: Filter) => {
    const next = new URLSearchParams(params);
    if (f === 'all') next.delete('who');
    else next.set('who', f);
    setParams(next, { replace: true });
  };
  const from = params.get('from');
  const to = params.get('to');
  const window_ =
    from && to && !isNaN(Date.parse(from)) && !isNaN(Date.parse(to)) ? { from, to } : null;
  const q = useQuery({
    queryKey: ['activity'],
    queryFn: () => api.get<{ sessions: Session[] }>('/activity?limit=500'),
  });
  const qc = useQueryClient();
  const toast = useToast();
  const [busy, setBusy] = useState<string | null>(null);

  async function undo(s: Session) {
    const n = new Set(s.events.map((e) => e.page_id)).size;
    if (
      !window.confirm(
        `Undo what ${actorLabel(s.actor)} did here? ${n} page(s): pages it created are deleted, pages it edited go back to how they were. Pages changed since by someone else are left alone.`,
      )
    )
      return;
    setBusy(s.start);
    try {
      const r = (await api.post<RevertResult>('/activity/revert', {
        actor: s.actor,
        from: s.start,
        to: s.end,
      })) as RevertResult;
      const parts = [
        r.restored.length && `${r.restored.length} restored`,
        r.deleted.length && `${r.deleted.length} deleted`,
        r.skipped.length && `${r.skipped.length} skipped`,
      ].filter(Boolean);
      toast(parts.length ? `Undone: ${parts.join(', ')}.` : 'Nothing to undo.');
      if (r.skipped.length)
        window.alert(r.skipped.map((x) => `${x.title}: ${x.reason}`).join('\n'));
      await Promise.all([
        qc.invalidateQueries({ queryKey: ['activity'] }),
        qc.invalidateQueries({ queryKey: keys.tree }),
        qc.invalidateQueries({ queryKey: ['page'] }),
        qc.invalidateQueries({ queryKey: ['dashboard'] }),
      ]);
    } catch (e) {
      toast(errorMessage(e));
    } finally {
      setBusy(null);
    }
  }

  const inWindow = (iso: string) =>
    !window_ ||
    (Date.parse(iso) >= Date.parse(window_.from) && Date.parse(iso) < Date.parse(window_.to));
  const sessions = (q.data?.sessions ?? [])
    .filter((s) =>
      filter === 'all' ? true : filter === 'agents' ? isAgent(s.actor) : s.actor === 'you',
    )
    .map((s) => (window_ ? { ...s, events: s.events.filter((e) => inWindow(e.created_at)) } : s))
    .filter((s) => s.events.length > 0);

  return (
    <div className="page activity">
      <h1 className="page-title view-title">
        <Icon name="activity" size={26} /> Activity
      </h1>
      <WhoToggle value={filter} onChange={setFilter} label="Show" />
      {window_ && (
        <p className="act-window">
          Showing {formatTime(window_.from)} to {formatTime(window_.to)} on{' '}
          {formatDay(window_.from)}.{' '}
          <button
            className="link"
            onClick={() => setParams(filter === 'all' ? {} : { who: filter }, { replace: true })}
          >
            Show all
          </button>
        </p>
      )}
      {q.isPending && <p className="muted">Loading…</p>}
      {q.data && !sessions.length && <p className="muted">Nothing yet.</p>}
      {sessions.map((s, i) => {
        const day = formatDay(s.end);
        const showDay = i === 0 || day !== formatDay(sessions[i - 1]!.end);
        const pages = new Set(s.events.map((e) => e.page_id)).size;
        return (
          <div key={`${s.actor}-${s.start}`}>
            {showDay && <h2 className="act-day">{day}</h2>}
            <section className={`act-session ${isAgent(s.actor) ? 'agent' : ''}`}>
              <header>
                <strong>{actorLabel(s.actor)}</strong>
                <span className="muted act-when">
                  <span className="nowrap">
                    {formatTime(s.start)}
                    {formatTime(s.start) !== formatTime(s.end) && ` to ${formatTime(s.end)}`}
                  </span>{' '}
                  · <span className="nowrap">{`${pages} page${pages === 1 ? '' : 's'}`}</span>
                </span>
                {isAgent(s.actor) && (
                  <button
                    className="btn small"
                    disabled={busy === s.start}
                    onClick={() => void undo(s)}
                  >
                    Undo session
                  </button>
                )}
              </header>
              <ul>
                {s.events.map((e) => (
                  <li key={e.id}>
                    <span className="act-verb">{eventVerb(e)}</span>
                    {e.exists ? (
                      <Link to={pageHref(e.page_id, e.title)}>{e.title}</Link>
                    ) : (
                      <span className="gone">{e.title}</span>
                    )}
                    <span className="muted">{formatTime(e.created_at)}</span>
                  </li>
                ))}
              </ul>
            </section>
          </div>
        );
      })}
    </div>
  );
}
