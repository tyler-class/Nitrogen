// Home: a fixed layout of what needs you and where you left off. Wide screens show two columns
// (open items and recent edits on the left; pinned pages and AI sessions on the right); phones
// stack them. Insights is the arrangeable board; Home stays put.
import { useState, type ReactNode } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Link, useSearchParams } from 'react-router';
import { actorLabel, isAgent } from '@shared/actor';
import { pageHref } from '@shared/markdown';
import { todayKey } from '@shared/items';
import type { Dashboard as DashboardData, SessionEntry } from '@shared/types';
import { api, errorMessage } from '../lib/api';
import { keys } from '../lib/queries';
import { useToast } from '../components/Toast';
import { eventLine } from '../lib/activity';
import { readLocal, writeLocal } from '../lib/storage';
import { WhoToggle, type Who } from '../components/charts';
import {
  ItemsEmpty,
  OpenItemsToggle,
  parseShow,
  showFilter,
  showHref,
  type Show,
} from '../components/OpenItemsFilter';
import { ItemRow } from '../components/ItemRow';
import { PinnedList } from '../components/PinnedList';
import { EmptyState } from '../components/EmptyState';
import { useOpenItems } from '../lib/useOpenItems';
import { Icon } from '../components/Icon';
import { formatWhen } from './PageView';

const OPEN_SHOWN = 10;
const SESSIONS_SHOWN = 4;

/** One section of Home: an icon and title, a "View all" link, its controls, then its body. */
function Card({
  icon,
  title,
  link,
  sub,
  actions,
  className = '',
  children,
}: {
  icon: string;
  title: string;
  link?: string;
  sub?: ReactNode;
  actions?: ReactNode;
  className?: string;
  children: ReactNode;
}) {
  return (
    <section className={`home-card ${className}`} aria-label={title}>
      <header className="home-card-h">
        <h2>
          <span className="home-card-icon" aria-hidden>
            <Icon name={icon} size={17} />
          </span>
          {title}
          {link && (
            <Link to={link} className="pn-link">
              View all
            </Link>
          )}
        </h2>
        {sub && <p className="home-card-sub">{sub}</p>}
      </header>
      {actions && <div className="home-card-actions">{actions}</div>}
      {children}
    </section>
  );
}

export function Dashboard() {
  const q = useQuery({
    queryKey: ['dashboard'],
    queryFn: () => api.get<DashboardData>('/dashboard'),
    refetchInterval: 60_000,
  });
  // The same rows and actions as the Open Items page: check off, answer, edit, delete.
  const items = useOpenItems();
  const sessions = useQuery({
    queryKey: ['sessions'],
    queryFn: () => api.get<{ root_id: string | null; entries: SessionEntry[] }>('/sessions'),
  });
  // The same filter as the Open Items page. "/?items=question" (older notifications) opens on
  // Questions.
  const [params] = useSearchParams();
  const asked = params.get('items');
  const fromUrl = (v: string | null): Show => (v === 'question' ? 'questions' : parseShow(v));
  const [show, setShow] = useState<Show>(() => fromUrl(asked));
  const [seen, setSeen] = useState(asked);
  if (seen !== asked) {
    setSeen(asked);
    if (asked) setShow(fromUrl(asked));
  }
  // Recently edited: everyone's, yours or assistants' (remembered on this device).
  const [who, setWhoState] = useState<Who>(() => readLocal<Who>('n2.home.who', 'all'));
  const setWho = (w: Who) => {
    setWhoState(w);
    writeLocal('n2.home.who', w);
  };
  const qc = useQueryClient();
  const toast = useToast();
  /** Pin or unpin a page from here (unpinning offers Undo). */
  async function setPinned(p: { id: string; title: string }, pinned: boolean) {
    try {
      await api.post(`/pages/${p.id}/pin`, { pinned });
      await qc.invalidateQueries({ queryKey: ['dashboard'] });
      void qc.invalidateQueries({ queryKey: keys.page(p.id) });
      if (!pinned)
        toast(`Unpinned “${p.title}”.`, {
          label: 'Undo',
          run: () => void setPinned(p, true),
        });
    } catch (e) {
      toast(errorMessage(e));
    }
  }
  /** Save a new order for the pinned pages, showing it straight away. */
  async function reorderPinned(ids: string[]) {
    const before = qc.getQueryData<DashboardData>(['dashboard']);
    qc.setQueryData<DashboardData>(['dashboard'], (old) =>
      old
        ? {
            ...old,
            pinned: ids
              .map((id) => old.pinned.find((p) => p.id === id))
              .filter((p): p is (typeof old.pinned)[number] => !!p),
          }
        : old,
    );
    try {
      await api.post('/pinned/order', { ids });
    } catch (e) {
      qc.setQueryData(['dashboard'], before);
      toast(errorMessage(e));
    }
  }
  const d = q.data;
  if (!d) return <div className="page-loading" aria-busy="true" />;

  // Lists filtered on the server, and checked again here so a stale response can't mix them.
  const recent =
    (who === 'you' ? d.activity_you : who === 'agents' ? d.activity_agents : d.activity)?.filter(
      (e) => (who === 'you' ? e.actor === 'you' : who === 'agents' ? isAgent(e.actor) : true),
    ) ?? [];
  const today = todayKey();
  const live = items.live;
  const open = items.all.filter(showFilter(today)[show]);
  // To-dos and questions due today or overdue (reminders are nudges, not due).
  const dueNow = open.filter((i) => i.type !== 'reminder' && i.due && i.due <= today).length;
  const latestSessions = (sessions.data?.entries ?? []).slice(0, SESSIONS_SHOWN);

  return (
    <div className="page dashboard home">
      <h1 className="page-title view-title">
        <Icon name="home" size={26} /> Home
      </h1>
      <div className="home-grid">
        <div className="home-col home-main">
          {/* Only while something is open (anywhere, whatever the filter). */}
          {(items.q.isPending || items.all.length > 0) && (
            <Card
              icon="checks"
              title="Open Items"
              className="home-open"
              link={showHref(show)}
              sub={dueNow ? `${dueNow} due today or overdue` : undefined}
              actions={
                <OpenItemsToggle value={show} onChange={setShow} items={live} today={today} />
              }
            >
              {open.length ? (
                <>
                  <ul className="items-full home-items">
                    {open.slice(0, OPEN_SHOWN).map((i) => (
                      <ItemRow key={items.idOf(i)} item={i} today={today} {...items.rowProps(i)} />
                    ))}
                  </ul>
                  {open.length > OPEN_SHOWN && (
                    <p className="see-all muted">
                      <Link to={showHref(show)}>and {open.length - OPEN_SHOWN} more</Link>
                    </p>
                  )}
                </>
              ) : items.q.isPending ? (
                <p className="pn-empty">Loading…</p>
              ) : (
                <ItemsEmpty show={show} />
              )}
            </Card>
          )}

          <Card
            icon="history"
            title="Recently edited"
            className="home-recent"
            link={who === 'all' ? '/activity' : `/activity?who=${who}`}
            actions={<WhoToggle value={who} onChange={setWho} label="Whose changes" />}
          >
            {recent.length ? (
              <ul className="dash-list">
                {recent.map((e) => (
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
              <EmptyState
                tone="plain"
                icon="history"
                title={
                  who === 'you'
                    ? 'No edits by you yet'
                    : who === 'agents'
                      ? 'No edits by assistants yet'
                      : 'No edits yet'
                }
                line={
                  who === 'agents'
                    ? 'Pages an assistant creates or changes show up here.'
                    : 'Pages you create or change show up here.'
                }
              />
            )}
          </Card>
        </div>

        <div className="home-col home-side">
          {/* Only once something is pinned (pin a page from its ⋯ menu). */}
          {d.pinned.length > 0 && (
            <Card icon="pin" title="Pinned" className="home-pinned">
              <PinnedList
                pages={d.pinned}
                onUnpin={(p) => void setPinned(p, false)}
                onReorder={(ids) => void reorderPinned(ids)}
              />
            </Card>
          )}

          <Card icon="sparkle" title="Recent AI sessions" link="/sessions" className="home-ai">
            {latestSessions.length ? (
              <ul className="home-sessions">
                {latestSessions.map((s) => (
                  <li key={s.id}>
                    {/* The session's log, not the pages it touched. */}
                    <Link to={`/sessions/${s.id}`}>
                      <span className="home-session-title">{s.title || 'Untitled session'}</span>
                      <span className="home-session-meta">
                        {actorLabel(s.actor)} · {formatWhen(s.ended_at)}
                        {s.pages > 0 && ` · ${s.pages} ${s.pages === 1 ? 'page' : 'pages'}`}
                      </span>
                      {s.summary && <span className="home-session-sum">{s.summary}</span>}
                    </Link>
                  </li>
                ))}
              </ul>
            ) : sessions.isPending ? (
              <p className="pn-empty">Loading…</p>
            ) : (
              <EmptyState
                tone="plain"
                icon="sparkle"
                title="No AI sessions yet"
                line="When an assistant works in your wiki, its session shows up here."
              />
            )}
          </Card>
        </div>
      </div>
    </div>
  );
}
