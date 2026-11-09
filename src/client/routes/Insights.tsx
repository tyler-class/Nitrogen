// Insights, laid out like Ratio's: number tiles, a calendar, then pairs of cards, each with its
// own small toggles. Everything is computed here from one /insights response.
import { useMemo, useState, type ReactNode } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Link } from 'react-router';
import { actorLabel, isAgent } from '@shared/actor';
import { pageHref } from '@shared/markdown';
import type { Insights as InsightsData, PageStat } from '@shared/types';
import { api } from '../lib/api';
import {
  Chips,
  Columns,
  dayKey,
  Heatmap,
  Rank,
  Stat,
  type Col,
  type RankRow,
} from '../components/charts';
import { PageGlyph, Icon } from '../components/Icon';
import { PanelBoard, type PanelDef } from '../components/Panels';
import { usePanelLayout } from '../lib/queries';
import { formatWhen } from './PageView';
import '../styles/viz.css';
import '../styles/insights.css';

type Who = 'all' | 'you' | 'agents';
const WHO = [
  ['all', 'Everyone'],
  ['you', 'You'],
  ['agents', 'Assistants'],
] as const;

type Dim = 'edited' | 'linked' | 'biggest' | 'quiet' | 'orphans' | 'empty';
const DIMS = [
  ['edited', 'Most edited'],
  ['linked', 'Most linked'],
  ['biggest', 'Biggest'],
  ['quiet', 'Quietest'],
  ['orphans', 'Unlinked'],
  ['empty', 'Empty'],
] as const;

type Period = 'e7' | 'e30' | 'e90' | 'eall';
const PERIODS = [
  ['e7', '7 days'],
  ['e30', '30 days'],
  ['e90', '90 days'],
  ['eall', 'All time'],
] as const;

const MO = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const fmt = (n: number) => n.toLocaleString();
const plural = (n: number, w: string) => `${fmt(n)} ${w}${n === 1 ? '' : 's'}`;
const DAY = 86_400_000;

export function Insights() {
  const q = useQuery({ queryKey: ['insights'], queryFn: () => api.get<InsightsData>('/insights') });
  const [who, setWho] = useState<Who>('all');
  const [authorBy, setAuthorBy] = useState<'edits' | 'created'>('edits');
  const [dim, setDim] = useState<Dim>('edited');
  const [period, setPeriod] = useState<Period>('e30');
  const d = q.data;
  const layout = usePanelLayout('insights_layout');
  const [weeks, setWeeks] = useState(26);

  const m = useMemo(() => (d ? model(d) : null), [d]);
  if (!d || !m || !layout.ready) return <div className="page-loading" aria-busy="true" />;

  if (!d.pages.length)
    return (
      <div className="page insights">
        <h1 className="page-title view-title">
          <Icon name="insights" size={26} /> Insights
        </h1>
        <div className="panel empty">Write a few pages to see patterns here.</div>
      </div>
    );

  const counts = new Map(
    d.days.map((x) => [
      x.day,
      who === 'you' ? x.you : who === 'agents' ? x.agents : x.you + x.agents,
    ]),
  );
  const weekly: Col[] = m.weeks.map((w, i) => ({
    label: w.label,
    values: who === 'you' ? [w.you] : who === 'agents' ? [0, w.agents] : [w.you, w.agents],
    current: i === m.weeks.length - 1,
    title: `Week of ${w.label}: ${w.you} by you, ${w.agents} by assistants`,
  }));

  const authors = [...d.authors]
    .map((a) => ({ ...a, v: authorBy === 'edits' ? a.edits : a.created }))
    .filter((a) => a.v > 0)
    .sort((a, b) => b.v - a.v);

  const explorer = explore(d, dim, period, m.byId);
  const pageLink = (r: RankRow, body: ReactNode) => (
    <Link to={r.href!} className="rk-link">
      {body}
    </Link>
  );

  const attention = (
    [
      ['orphans', 'Nothing links to them', m.orphans.length],
      ['quiet', 'Not touched in 90 days', m.stale],
      ['empty', 'Empty pages', m.empty],
    ] as const
  ).map(([k, label, n]) => (
    <button
      key={label}
      type="button"
      onClick={() => {
        setDim(k);
        document
          .querySelector('[aria-label="Page explorer"]')
          ?.scrollIntoView({ behavior: 'smooth', block: 'start' });
      }}
    >
      <span>{label}</span>
      <strong>{fmt(n)}</strong>
    </button>
  ));

  const panels: PanelDef[] = [
    {
      id: 'glance',
      title: 'At a glance',
      size: 'full',
      body: (
        <div className="stats">
          <Stat v={fmt(d.pages.length)} l="Pages" d={`${fmt(m.new30)} new in 30 days`} />
          <Stat
            v={fmt(m.words)}
            l="Words"
            d={`about ${fmt(Math.round(m.words / d.pages.length))} per page`}
          />
          <Stat
            v={fmt(m.edits30)}
            l="Edits, 30 days"
            d={
              m.edits30 ? `${Math.round((m.agents30 / m.edits30) * 100)}% by assistants` : undefined
            }
          />
          <Stat
            v={plural(m.streak, 'day')}
            l="Writing streak"
            d={`longest ${plural(m.longest, 'day')}`}
          />
          <Stat v={fmt(d.links)} l="Links" d={`${fmt(m.orphans.length)} pages with none in`} />
          <Stat
            v={fmt(d.tags.length)}
            l="Tags"
            d={d.tags[0] ? `#${d.tags[0].tag} most used` : 'none yet'}
          />
        </div>
      ),
    },
    {
      id: 'calendar',
      title: 'Your wiki calendar',
      sub: `Last ${weeks} weeks. Darker days had more edits.`,
      size: 'full',
      actions: <Chips label="Whose edits" options={WHO} value={who} onChange={setWho} />,
      body: (
        <Heatmap counts={counts} tone={who === 'agents' ? 'agents' : 'you'} onWeeks={setWeeks} />
      ),
    },
    {
      id: 'weekly',
      title: 'Edits per week',
      sub: 'Last 12 weeks; follows the calendar’s filter',
      size: 'half',
      body: (
        <>
          <Columns data={weekly} />
          {who === 'all' && <Legend />}
        </>
      ),
    },
    {
      id: 'authors',
      title: 'Who writes your wiki',
      size: 'half',
      actions: (
        <Chips
          label="Count"
          options={[
            ['edits', 'Edits'],
            ['created', 'Pages created'],
          ]}
          value={authorBy}
          onChange={setAuthorBy}
        />
      ),
      body: (
        <>
          {authors.length ? (
            <Rank
              rows={authors.map((a) => ({
                key: a.actor ?? 'unknown',
                label: actorLabel(a.actor),
                value: a.v,
                vl: plural(a.v, authorBy === 'edits' ? 'edit' : 'page'),
                tone: a.actor === null ? 'unknown' : isAgent(a.actor) ? 'agents' : 'you',
              }))}
              max={authors[0]!.v}
            />
          ) : (
            <div className="empty">Nothing yet.</div>
          )}
          {authors.some((a) => a.actor === null) && (
            <div className="hint">
              “Someone” is from before Nitrogen recorded who made a change.
            </div>
          )}
        </>
      ),
    },
    {
      id: 'explorer',
      title: 'Page explorer',
      size: 'full',
      actions: (
        <>
          <Chips label="Show" options={DIMS} value={dim} onChange={setDim} />
          {dim === 'edited' && (
            <Chips label="Period" options={PERIODS} value={period} onChange={setPeriod} />
          )}
        </>
      ),
      body: explorer.rows.length ? (
        <Rank rows={explorer.rows} max={explorer.max} link={pageLink} />
      ) : (
        <div className="empty">{explorer.empty}</div>
      ),
    },
    {
      id: 'months',
      title: 'New pages per month',
      sub: 'Pages that still exist, by when they were created',
      size: 'half',
      body: <Columns data={m.months} tones={['you']} />,
    },
    {
      id: 'tags',
      title: 'Top tags',
      sub: 'Pages per tag',
      size: 'half',
      body: d.tags.length ? (
        <Rank
          rows={d.tags.slice(0, 8).map((t) => ({
            key: t.tag,
            label: `#${t.tag}`,
            value: t.count,
            vl: plural(t.count, 'page'),
            href: `/tags/${encodeURIComponent(t.tag)}`,
          }))}
          max={d.tags[0]!.count}
          link={pageLink}
        />
      ) : (
        <div className="empty">Tag pages to see them here.</div>
      ),
    },
    {
      id: 'misses',
      title: 'What assistants couldn’t find',
      sub: 'Searches with no results, last 90 days. Pages worth writing.',
      size: 'half',
      body: d.misses.length ? (
        <ul className="misses">
          {d.misses.map((x) => (
            <li key={x.query}>
              <span className="q">“{x.query}”</span>
              <span className="sub">
                {x.count > 1 ? `${x.count}× · ` : ''}
                {formatWhen(x.last)}
              </span>
            </li>
          ))}
        </ul>
      ) : (
        <div className="empty">Nothing yet.</div>
      ),
    },
    {
      id: 'attention',
      title: 'Needs attention',
      sub: 'Open one in the page explorer',
      size: 'half',
      body: <div className="attn">{attention}</div>,
    },
  ];

  return (
    <div className="page insights">
      <h1 className="page-title view-title">
        <Icon name="insights" size={26} /> Insights
      </h1>
      <PanelBoard defs={panels} saved={layout.saved} onSave={layout.save} />
    </div>
  );
}

function Legend() {
  return (
    <div className="legend">
      <span>
        <i className="lg-you" />
        You
      </span>
      <span>
        <i className="lg-agents" />
        Assistants
      </span>
    </div>
  );
}

/** Everything derived once per response. */
function model(d: InsightsData) {
  const now = Date.now();
  const byId = new Map(d.pages.map((p) => [p.id, p]));
  const byDay = new Map(d.days.map((x) => [x.day, x]));

  // Weeks start Monday; last 12 including this one.
  const today = new Date();
  const monday = new Date(today.getFullYear(), today.getMonth(), today.getDate());
  monday.setDate(monday.getDate() - ((monday.getDay() + 6) % 7));
  const weeks = [];
  for (let i = 11; i >= 0; i--) {
    const s = new Date(monday.getFullYear(), monday.getMonth(), monday.getDate() - i * 7);
    let you = 0;
    let agents = 0;
    for (let k = 0; k < 7; k++) {
      const v = byDay.get(dayKey(new Date(s.getFullYear(), s.getMonth(), s.getDate() + k)));
      you += v?.you ?? 0;
      agents += v?.agents ?? 0;
    }
    weeks.push({ label: `${s.getMonth() + 1}/${s.getDate()}`, you, agents });
  }

  // Streaks count days with any edit; today without one doesn't break it yet.
  let streak = 0;
  for (let i = 0; ; i++) {
    const day = dayKey(new Date(now - i * DAY));
    const v = byDay.get(day);
    if (v && v.you + v.agents > 0) streak++;
    else if (i > 0) break;
  }
  let longest = 0;
  let run = 0;
  let prev = 0;
  for (const x of d.days) {
    const t = Date.parse(`${x.day}T00:00:00Z`);
    run = x.you + x.agents > 0 ? (prev && t - prev === DAY ? run + 1 : 1) : 0;
    prev = t;
    longest = Math.max(longest, run);
  }

  let edits30 = 0;
  let agents30 = 0;
  const cutoff = dayKey(new Date(now - 29 * DAY));
  for (const x of d.days)
    if (x.day >= cutoff) {
      edits30 += x.you + x.agents;
      agents30 += x.agents;
    }

  const months: Col[] = [];
  for (let i = 11; i >= 0; i--) {
    const dt = new Date(today.getFullYear(), today.getMonth() - i, 1);
    const key = `${dt.getFullYear()}-${String(dt.getMonth() + 1).padStart(2, '0')}`;
    const n = d.pages.filter((p) => p.created_at.startsWith(key)).length;
    months.push({ label: MO[dt.getMonth()]!, values: [n], current: i === 0 });
  }

  return {
    byId,
    weeks,
    months,
    streak,
    longest: Math.max(longest, streak),
    edits30,
    agents30,
    words: d.pages.reduce((s, p) => s + p.words, 0),
    new30: d.pages.filter((p) => now - Date.parse(p.created_at) < 30 * DAY).length,
    orphans: d.pages.filter((p) => !p.backlinks),
    stale: d.pages.filter((p) => now - Date.parse(p.updated_at) > 90 * DAY).length,
    empty: d.pages.filter((p) => !p.words).length,
  };
}

function pathOf(p: PageStat, byId: Map<string, PageStat>): string {
  const out: string[] = [];
  const seen = new Set([p.id]);
  let cur = p.parent_id;
  while (cur && !seen.has(cur)) {
    const x = byId.get(cur);
    if (!x) break;
    out.unshift(x.title);
    seen.add(cur);
    cur = x.parent_id;
  }
  return out.join(' › ');
}

function explore(
  d: InsightsData,
  dim: Dim,
  period: Period,
  byId: Map<string, PageStat>,
): { rows: RankRow[]; max: number; empty: string } {
  const label = (p: PageStat) => (
    <>
      <PageGlyph icon={p.icon} folder={false} /> {p.title}
    </>
  );
  const row = (p: PageStat, value: number, vl: string, sub?: string): RankRow => ({
    key: p.id,
    label: label(p),
    value,
    vl,
    sub: sub ?? (pathOf(p, byId) || undefined),
    href: pageHref(p.id, p.title),
  });
  const now = Date.now();
  let list: RankRow[] = [];
  let empty = 'Nothing here.';
  switch (dim) {
    case 'edited':
      list = [...d.pages]
        .filter((p) => p[period] > 0)
        .sort((a, b) => b[period] - a[period] || b.updated_at.localeCompare(a.updated_at))
        .map((p) => row(p, p[period], plural(p[period], 'edit')));
      empty = 'No edits in this period.';
      break;
    case 'linked':
      list = [...d.pages]
        .filter((p) => p.backlinks > 0)
        .sort((a, b) => b.backlinks - a.backlinks)
        .map((p) => row(p, p.backlinks, plural(p.backlinks, 'link')));
      empty = 'No links yet. Link pages with [[Page title]].';
      break;
    case 'biggest':
      list = [...d.pages]
        .sort((a, b) => b.words - a.words)
        .map((p) => row(p, p.words, plural(p.words, 'word')));
      break;
    case 'quiet': {
      const ages = d.pages.map((p) => (now - Date.parse(p.updated_at)) / 86_400_000);
      list = [...d.pages]
        .map((p, i) => ({ p, age: ages[i]! }))
        .sort((a, b) => b.age - a.age)
        .map(({ p, age }) => row(p, age, formatWhen(p.updated_at)));
      break;
    }
    case 'orphans':
      list = d.pages
        .filter((p) => !p.backlinks)
        .sort((a, b) => b.updated_at.localeCompare(a.updated_at))
        .map((p) => row(p, 1, formatWhen(p.updated_at)));
      empty = 'Every page has at least one link in.';
      break;
    case 'empty':
      list = d.pages
        .filter((p) => !p.words)
        .sort((a, b) => b.updated_at.localeCompare(a.updated_at))
        .map((p) => row(p, 1, formatWhen(p.updated_at)));
      empty = 'No empty pages.';
      break;
  }
  const rows = list.slice(0, 10);
  return { rows, max: Math.max(1, ...rows.map((r) => r.value)), empty };
}
