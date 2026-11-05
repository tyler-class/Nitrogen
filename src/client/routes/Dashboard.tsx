import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Link } from 'react-router';
import { actorLabel } from '@shared/actor';
import { pageHref } from '@shared/markdown';
import type { Dashboard as DashboardData, DashboardSectionId } from '@shared/types';
import { api, errorMessage } from '../lib/api';
import { eventLine } from '../lib/activity';
import { Icon, PageGlyph } from '../components/Icon';
import { useToast } from '../components/Toast';
import { formatWhen } from './PageView';

export const SECTION_LABELS: Record<DashboardSectionId, string> = {
  stats: 'Numbers',
  inbox: 'Inbox',
  pinned: 'Pinned',
  activity: 'Recent activity',
};

const fmt = (n: number) => n.toLocaleString();

export function Dashboard() {
  const q = useQuery({
    queryKey: ['dashboard'],
    queryFn: () => api.get<DashboardData>('/dashboard'),
    refetchInterval: 60_000,
  });
  const qc = useQueryClient();
  const toast = useToast();
  const d = q.data;

  async function clearInbox() {
    try {
      await api.post('/inbox/clear');
      await qc.invalidateQueries({ queryKey: ['dashboard'] });
    } catch (e) {
      toast(errorMessage(e));
    }
  }

  if (!d) return <div className="page-loading" aria-busy="true" />;

  const blocks: Record<DashboardSectionId, React.ReactNode> = {
    stats: (
      <div className="stat-strip">
        <div>
          <strong>{fmt(d.stats.pages)}</strong>
          <span>pages</span>
        </div>
        <div>
          <strong>{fmt(d.stats.words)}</strong>
          <span>words</span>
        </div>
        <div>
          <strong>{fmt(d.stats.edits_week)}</strong>
          <span>
            edits this week
            {d.stats.edits_week > 0 &&
              ` · ${Math.round((d.stats.agent_edits_week / d.stats.edits_week) * 100)}% by assistants`}
          </span>
        </div>
        <div>
          <strong>{fmt(d.stats.tags)}</strong>
          <span>tags</span>
        </div>
      </div>
    ),
    inbox: (
      <section className="dash-section" aria-label="Inbox">
        <div className="dash-head">
          <h2>
            <Icon name="inbox" size={16} /> Inbox
            {d.inbox.length > 0 && <span className="count">{d.inbox.length}</span>}
          </h2>
          {d.inbox.length > 0 && (
            <button className="btn small" onClick={clearInbox}>
              Mark all read
            </button>
          )}
        </div>
        {d.inbox.length ? (
          <ul className="dash-list">
            {d.inbox.map((p) => (
              <li key={p.id}>
                <Link to={pageHref(p.id, p.title)}>
                  <PageGlyph icon={p.icon} folder={false} />
                  <span className="dash-title">{p.title}</span>
                </Link>
                <span className={`badge ${p.is_new ? 'new' : ''}`}>
                  {p.is_new ? 'New' : 'Updated'}
                </span>
                <span className="dash-meta">
                  {actorLabel(p.updated_by)} · {formatWhen(p.updated_at)}
                </span>
              </li>
            ))}
          </ul>
        ) : (
          <p className="muted">All caught up.</p>
        )}
      </section>
    ),
    pinned: (
      <section className="dash-section" aria-label="Pinned">
        <div className="dash-head">
          <h2>
            <Icon name="pin" size={16} /> Pinned
          </h2>
        </div>
        {d.pinned.length ? (
          <div className="cards">
            {d.pinned.map((p) => (
              <Link key={p.id} to={pageHref(p.id, p.title)} className="card">
                <PageGlyph icon={p.icon} folder={false} />
                <span>{p.title}</span>
              </Link>
            ))}
          </div>
        ) : (
          <p className="muted">Pin pages from their ⋯ menu.</p>
        )}
      </section>
    ),
    activity: (
      <section className="dash-section" aria-label="Recent activity">
        <div className="dash-head">
          <h2>
            <Icon name="activity" size={16} /> Recent activity
          </h2>
          <Link to="/activity" className="btn small">
            All activity
          </Link>
        </div>
        {d.activity.length ? (
          <ul className="dash-list">
            {d.activity.map((e) => (
              <li key={e.id}>
                <span className={`who ${e.actor?.startsWith('agent:') ? 'agent' : ''}`}>
                  {eventLine(e)}
                </span>
                {e.exists ? (
                  <Link to={pageHref(e.page_id, e.title)} className="dash-title">
                    {e.title}
                  </Link>
                ) : (
                  <span className="dash-title gone">{e.title}</span>
                )}
                <span className="dash-meta">{formatWhen(e.created_at)}</span>
              </li>
            ))}
          </ul>
        ) : (
          <p className="muted">Nothing yet.</p>
        )}
      </section>
    ),
  };

  return (
    <div className="page dashboard">
      <div className="dash-top">
        <h1 className="page-title">Dashboard</h1>
        <Link to="/settings#dashboard" className="btn small">
          Customize
        </Link>
      </div>
      {d.sections
        .filter((s) => s.on)
        .map((s) => (
          <div key={s.id}>{blocks[s.id]}</div>
        ))}
    </div>
  );
}
