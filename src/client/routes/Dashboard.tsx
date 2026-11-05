import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Link } from 'react-router';
import { actorLabel, isAgent } from '@shared/actor';
import { pageHref } from '@shared/markdown';
import type { Dashboard as DashboardData } from '@shared/types';
import { api, errorMessage } from '../lib/api';
import { eventLine } from '../lib/activity';
import { usePanelLayout } from '../lib/queries';
import { Stat } from '../components/charts';
import { PageGlyph } from '../components/Icon';
import { PanelBoard, type PanelDef } from '../components/Panels';
import { useToast } from '../components/Toast';
import { formatWhen } from './PageView';

const fmt = (n: number) => n.toLocaleString();

export function Dashboard() {
  const q = useQuery({
    queryKey: ['dashboard'],
    queryFn: () => api.get<DashboardData>('/dashboard'),
    refetchInterval: 60_000,
  });
  const layout = usePanelLayout('dashboard_layout');
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

  if (!d || !layout.ready) return <div className="page-loading" aria-busy="true" />;

  const panels: PanelDef[] = [
    {
      id: 'stats',
      title: 'At a glance',
      size: 'full',
      body: (
        <div className="stats four">
          <Stat v={fmt(d.stats.pages)} l="Pages" />
          <Stat v={fmt(d.stats.words)} l="Words" />
          <Stat
            v={fmt(d.stats.edits_week)}
            l="Edits this week"
            d={
              d.stats.edits_week
                ? `${Math.round((d.stats.agent_edits_week / d.stats.edits_week) * 100)}% by assistants`
                : undefined
            }
          />
          <Stat v={fmt(d.stats.tags)} l="Tags" />
        </div>
      ),
    },
    {
      id: 'inbox',
      title: d.inbox.length ? `Inbox · ${d.inbox.length}` : 'Inbox',
      sub: 'What assistants changed since you last looked',
      size: 'half',
      actions: d.inbox.length ? (
        <button className="btn small" onClick={clearInbox}>
          Mark all read
        </button>
      ) : undefined,
      body: d.inbox.length ? (
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
        <p className="pn-empty">All caught up.</p>
      ),
    },
    {
      id: 'pinned',
      title: 'Pinned',
      sub: 'Pin pages from their ⋯ menu',
      size: 'half',
      body: d.pinned.length ? (
        <ul className="dash-list">
          {d.pinned.map((p) => (
            <li key={p.id}>
              <Link to={pageHref(p.id, p.title)}>
                <PageGlyph icon={p.icon} folder={false} />
                <span className="dash-title">{p.title}</span>
              </Link>
              <span className="dash-meta">{formatWhen(p.updated_at)}</span>
            </li>
          ))}
        </ul>
      ) : (
        <p className="pn-empty">Nothing pinned yet.</p>
      ),
    },
    {
      id: 'activity',
      title: 'Recent activity',
      size: 'full',
      actions: (
        <Link to="/activity" className="btn small">
          All activity
        </Link>
      ),
      body: d.activity.length ? (
        <ul className="dash-list">
          {d.activity.map((e) => (
            <li key={e.id}>
              <span className={`who ${isAgent(e.actor) ? 'agent' : ''}`}>{eventLine(e)}</span>
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
        <p className="pn-empty">Nothing yet.</p>
      ),
    },
  ];

  return (
    <div className="page dashboard">
      <h1 className="page-title">Dashboard</h1>
      <PanelBoard defs={panels} saved={layout.saved} onSave={layout.save} />
    </div>
  );
}
