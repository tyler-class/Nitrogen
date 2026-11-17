// Home: a fixed layout of what needs you and where you left off. Wide screens show two columns
// (open items and recent edits on the left; pinned pages and AI sessions on the right); phones
// stack them. Insights is the arrangeable board; Home stays put.
import { useState, type ReactNode } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Link, useSearchParams } from 'react-router';
import { actorLabel, isAgent } from '@shared/actor';
import { pageHref, plainText } from '@shared/markdown';
import {
  ITEM_LABELS,
  dateWords,
  isOverdue,
  nowMoment,
  reminderPast,
  todayKey,
} from '@shared/items';
import type { Dashboard as DashboardData, OpenItem, SessionEntry } from '@shared/types';
import { api } from '../lib/api';
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
import { formatDue } from '../components/Markdown';
import { Icon, PageGlyph } from '../components/Icon';
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
  const items = useQuery({
    queryKey: ['items'],
    queryFn: () => api.get<{ items: OpenItem[] }>('/items'),
    refetchInterval: 60_000,
  });
  const sessions = useQuery({
    queryKey: ['sessions'],
    queryFn: () => api.get<{ root_id: string | null; entries: SessionEntry[] }>('/sessions'),
  });
  // The same filter as the Open items page. "/?items=question" (older notifications) opens on
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
  const d = q.data;
  if (!d) return <div className="page-loading" aria-busy="true" />;

  // Lists filtered on the server, and checked again here so a stale response can't mix them.
  const recent =
    (who === 'you' ? d.activity_you : who === 'agents' ? d.activity_agents : d.activity)?.filter(
      (e) => (who === 'you' ? e.actor === 'you' : who === 'agents' ? isAgent(e.actor) : true),
    ) ?? [];
  const today = todayKey();
  const now = nowMoment();
  const live = items.data?.items.filter((i) => !reminderPast(i, now));
  const open = (live ?? []).filter(showFilter(today)[show]);
  // To-dos due today or overdue (reminders are nudges, not due).
  const dueNow = open.filter((i) => i.type === 'todo' && i.due && i.due <= today).length;
  const latestSessions = (sessions.data?.entries ?? []).slice(0, SESSIONS_SHOWN);

  return (
    <div className="page dashboard home">
      <h1 className="page-title view-title">
        <Icon name="home" size={26} /> Home
      </h1>
      <div className="home-grid">
        <div className="home-col home-main">
          <Card
            icon="checks"
            title="Open items"
            link={showHref(show)}
            sub={dueNow ? `${dueNow} due today or overdue` : undefined}
            actions={<OpenItemsToggle value={show} onChange={setShow} items={live} today={today} />}
          >
            {open.length ? (
              <ul className="dash-list open-items">
                {open.slice(0, OPEN_SHOWN).map((i) => (
                  <li key={`${i.page_id}-${i.line}`}>
                    <span className={`item-chip item-${i.type}`}>{ITEM_LABELS[i.type]}</span>
                    <Link
                      to={`${pageHref(i.page_id, i.page_title)}#item-${i.line}`}
                      className="dash-title"
                    >
                      {plainText(i.text)}
                    </Link>
                    <span className="dash-meta">
                      {i.due && (
                        <span className={isOverdue(i, today) ? 'overdue' : undefined}>
                          {dateWords(i, today).replace(' ·', '')} {formatDue(i.due, i.due_time)}{' '}
                          ·{' '}
                        </span>
                      )}
                      {i.page_title}
                    </span>
                  </li>
                ))}
                {open.length > OPEN_SHOWN && (
                  <li className="see-all muted">and {open.length - OPEN_SHOWN} more</li>
                )}
              </ul>
            ) : items.isPending ? (
              <p className="pn-empty">Loading…</p>
            ) : (
              <ItemsEmpty show={show} />
            )}
          </Card>

          <Card
            icon="history"
            title="Recently edited"
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
              <p className="pn-empty">Nothing yet.</p>
            )}
          </Card>
        </div>

        <div className="home-col home-side">
          {/* Only once something is pinned (pin a page from its ⋯ menu). */}
          {d.pinned.length > 0 && (
            <Card icon="pin" title="Pinned">
              <ul className="dash-list">
                {d.pinned.map((p) => (
                  <li key={p.id}>
                    <Link to={pageHref(p.id, p.title)}>
                      <PageGlyph icon={p.icon} folder={false} />
                      <span className="dash-title">{p.title}</span>
                    </Link>
                  </li>
                ))}
              </ul>
            </Card>
          )}

          <Card icon="sparkle" title="Recent AI sessions" link="/sessions">
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
            ) : (
              <p className="pn-empty">
                {sessions.isPending
                  ? 'Loading…'
                  : 'When an assistant works in your wiki, its session shows up here.'}
              </p>
            )}
          </Card>
        </div>
      </div>
    </div>
  );
}
