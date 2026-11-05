// Insights: what the wiki holds, who writes it, and what needs attention.
import '../styles/insights.css';
import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { Link } from 'react-router';
import { useQuery } from '@tanstack/react-query';
import { actorLabel, isAgent } from '@shared/actor';
import { pageHref } from '@shared/markdown';
import type { Insights as InsightsData } from '@shared/types';
import { api, errorMessage } from '../lib/api';
import { PageGlyph } from '../components/Icon';

const nf = new Intl.NumberFormat();
const fmt = (n: number) => nf.format(n);
const compact = new Intl.NumberFormat(undefined, { notation: 'compact', maximumFractionDigits: 1 });

function shortDate(iso: string) {
  return new Date(iso.length === 10 ? `${iso}T12:00:00` : iso).toLocaleDateString(undefined, {
    month: 'short',
    day: 'numeric',
    year: 'numeric',
  });
}

export function Insights() {
  const q = useQuery({ queryKey: ['insights'], queryFn: () => api.get<InsightsData>('/insights') });
  return (
    <div className="page insights">
      <h1 className="page-title">Insights</h1>
      {q.isPending ? (
        <p className="muted">Loading…</p>
      ) : q.error ? (
        <p className="muted">{errorMessage(q.error)}</p>
      ) : (
        <Body data={q.data} />
      )}
    </div>
  );
}

function Body({ data }: { data: InsightsData }) {
  const t = data.totals;
  return (
    <>
      <div className="totals">
        <Total n={t.pages} label="pages" />
        <Total n={t.words} label="words" />
        <Total n={t.links} label="links" />
        <Total n={t.tags} label="tags" />
        <Total n={t.empty} label="empty pages" />
      </div>

      <section>
        <h2>Activity</h2>
        <Heatmap days={data.days} />
      </section>

      <section>
        <h2>Who writes your wiki</h2>
        <p className="sub">All edits and pages created, by author.</p>
        <Authors authors={data.authors} />
      </section>

      <section>
        <h2>Growth</h2>
        <Growth growth={data.growth} />
      </section>

      <section>
        <h2>Busiest pages</h2>
        <div className="split">
          <RankList
            title="Most edited, last 30 days"
            items={data.most_edited.map((p) => ({
              ...p,
              n: `${p.edits} edit${p.edits === 1 ? '' : 's'}`,
            }))}
          />
          <RankList
            title="Most linked to"
            items={data.most_linked.map((p) => ({
              ...p,
              n: `${p.backlinks} link${p.backlinks === 1 ? '' : 's'}`,
            }))}
          />
        </div>
      </section>

      <section>
        <h2>Needs attention</h2>
        <div className="split">
          <RankList
            title="Not touched in 90 days"
            items={data.neglected.map((p) => ({ ...p, n: shortDate(p.updated_at) }))}
          />
          <RankList
            title={`Nothing links here (${fmt(data.orphans.count)})`}
            items={data.orphans.pages.map((p) => ({ ...p, n: '' }))}
          />
          <RankList
            title="Biggest pages"
            items={data.biggest.map((p) => ({ ...p, n: `${fmt(p.words)} words` }))}
          />
        </div>
      </section>

      <section>
        <h2>What assistants couldn’t find</h2>
        <p className="sub">Pages worth writing.</p>
        {data.misses.length ? (
          <ul className="rank">
            {data.misses.map((m) => (
              <li key={m.query}>
                <span className="q">“{m.query}”</span>
                <span className="n">
                  {m.count > 1 ? `${m.count}× · ` : ''}
                  {shortDate(m.last)}
                </span>
              </li>
            ))}
          </ul>
        ) : (
          <p className="muted">Nothing yet.</p>
        )}
      </section>
    </>
  );
}

function Total({ n, label }: { n: number; label: string }) {
  return (
    <div className="total">
      <strong>{n >= 10_000 ? compact.format(n) : fmt(n)}</strong>
      <span>{label}</span>
    </div>
  );
}

function RankList({
  title,
  items,
}: {
  title: string;
  items: { id: string; title: string; icon: string | null; n: string }[];
}) {
  return (
    <div>
      <h3>{title}</h3>
      {items.length ? (
        <ul className="rank">
          {items.map((p) => (
            <li key={p.id}>
              <Link to={pageHref(p.id, p.title)}>
                <PageGlyph icon={p.icon} folder={false} />
                <span>{p.title}</span>
              </Link>
              {p.n && <span className="n">{p.n}</span>}
            </li>
          ))}
        </ul>
      ) : (
        <p className="muted">None.</p>
      )}
    </div>
  );
}

// ---------------------------------------------------------------- tooltip

interface Tip {
  x: number;
  y: number;
  content: ReactNode;
}

function useTip() {
  const [tip, setTip] = useState<Tip | null>(null);
  /** Position relative to the chart container `box`, from a mark's bounding box. */
  const show = (box: HTMLElement | null, el: Element, content: ReactNode) => {
    const b = box?.getBoundingClientRect();
    const r = el.getBoundingClientRect();
    if (!b) return;
    setTip({ x: r.left + r.width / 2 - b.left, y: r.top - b.top, content });
  };
  return { tip, show, hide: () => setTip(null), setTip };
}

function TipView({ tip }: { tip: Tip | null }) {
  return tip ? (
    <div className="viz-tip" role="status" style={{ left: tip.x, top: tip.y }}>
      {tip.content}
    </div>
  ) : null;
}

// ---------------------------------------------------------------- heatmap

const CELL = 10;
const GAP = 2;
const WEEKS = 53;

function Heatmap({ days }: { days: InsightsData['days'] }) {
  const tip = useTip();
  const box = useRef<HTMLDivElement>(null);
  const scroller = useRef<HTMLDivElement>(null);
  // Narrow screens scroll the year sideways; start at the most recent weeks.
  useEffect(() => {
    const el = scroller.current;
    if (el) el.scrollLeft = el.scrollWidth;
  }, [days]);
  const { cells, months, total, agents, max } = useMemo(() => {
    const byDay = new Map(days.map((d) => [d.day, d]));
    const today = new Date();
    today.setHours(12, 0, 0, 0);
    // Start on the Sunday 52 weeks before this week's Sunday.
    const start = new Date(today);
    start.setDate(start.getDate() - start.getDay() - (WEEKS - 1) * 7);
    const cells: { day: string; you: number; agents: number; w: number; d: number }[] = [];
    const months: { w: number; label: string }[] = [];
    let total = 0;
    let agents = 0;
    let max = 0;
    for (let i = 0; ; i++) {
      const dt = new Date(start);
      dt.setDate(start.getDate() + i);
      if (dt > today) break;
      // The server groups events by UTC date.
      const day = new Date(Date.UTC(dt.getFullYear(), dt.getMonth(), dt.getDate()))
        .toISOString()
        .slice(0, 10);
      const v = byDay.get(day);
      const you = v?.you ?? 0;
      const ag = v?.agents ?? 0;
      const w = Math.floor(i / 7);
      if (dt.getDate() <= 7 && dt.getDay() === 0)
        months.push({ w, label: dt.toLocaleDateString(undefined, { month: 'short' }) });
      cells.push({ day, you, agents: ag, w, d: dt.getDay() });
      total += you + ag;
      agents += ag;
      max = Math.max(max, you + ag);
    }
    return { cells, months, total, agents, max };
  }, [days]);

  // Quartile-ish steps of the busiest day, so one huge day doesn't wash the rest out.
  const level = (n: number) => {
    if (!n) return 'empty';
    const r = n / Math.max(1, max);
    return r > 0.66 ? 'l4' : r > 0.33 ? 'l3' : r > 0.12 ? 'l2' : 'l1';
  };
  const left = 26;
  const top = 16;
  const width = left + WEEKS * (CELL + GAP);
  const height = top + 7 * (CELL + GAP);
  const share = total ? Math.round((agents / total) * 100) : 0;

  return (
    <>
      <p className="sub">
        {fmt(total)} edit{total === 1 ? '' : 's'} in the last year
        {total ? `, ${share}% by assistants` : ''}.
      </p>
      <div className="viz" ref={box} onMouseLeave={tip.hide}>
        <div className="heat-scroll" ref={scroller}>
          <svg
            className="heat"
            width={width}
            height={height}
            role="img"
            aria-label={`Edits per day over the last year: ${fmt(total)} in total, ${share}% by assistants.`}
          >
            {months.map((m) => (
              <text key={`${m.w}-${m.label}`} x={left + m.w * (CELL + GAP)} y={10}>
                {m.label}
              </text>
            ))}
            {['Mon', 'Wed', 'Fri'].map((l, i) => (
              <text key={l} x={0} y={top + (i * 2 + 1) * (CELL + GAP) + CELL - 2}>
                {l}
              </text>
            ))}
            {cells.map((c) => (
              <rect
                key={c.day}
                className={level(c.you + c.agents)}
                x={left + c.w * (CELL + GAP)}
                y={top + c.d * (CELL + GAP)}
                width={CELL}
                height={CELL}
                rx={2}
                onMouseEnter={(e) =>
                  tip.show(
                    box.current,
                    e.currentTarget,
                    <>
                      <b>{shortDate(c.day)}</b>
                      <br />
                      {c.you + c.agents ? (
                        <>
                          {fmt(c.you)} by you · {fmt(c.agents)} by assistants
                        </>
                      ) : (
                        <span className="muted">No edits</span>
                      )}
                    </>,
                  )
                }
              />
            ))}
          </svg>
        </div>
        <TipView tip={tip.tip} />
      </div>
      <div className="viz-legend">
        <span className="heat-scale">
          Fewer <i className="empty" />
          <i className="l1" />
          <i className="l2" />
          <i className="l3" />
          <i className="l4" /> More
        </span>
      </div>
    </>
  );
}

// ---------------------------------------------------------------- authors

function Authors({ authors }: { authors: InsightsData['authors'] }) {
  const tip = useTip();
  const box = useRef<HTMLDivElement>(null);
  if (!authors.length) return <p className="muted">No edits yet.</p>;
  const max = Math.max(1, ...authors.map((a) => a.edits));
  const kind = (a: string | null) => (isAgent(a) ? 'agents' : a === 'you' ? 'you' : 'unknown');
  return (
    <div className="viz" ref={box} onMouseLeave={tip.hide}>
      <ul className="bars">
        {authors.map((a) => (
          <li key={a.actor ?? 'unknown'} className="bar-row">
            <span className="bar-name">{actorLabel(a.actor)}</span>
            <span className="bar-track">
              <span
                className={`bar-fill ${kind(a.actor)}`}
                style={{ width: `${(a.edits / max) * 100}%` }}
                onMouseEnter={(e) =>
                  tip.show(
                    box.current,
                    e.currentTarget,
                    <>
                      <b>{actorLabel(a.actor)}</b>
                      <br />
                      {plural(a.edits, 'edit')} · {plural(a.created, 'page')} created
                    </>,
                  )
                }
              />
            </span>
            <span className="bar-val">
              {plural(a.edits, 'edit')} · {plural(a.created, 'page')}
            </span>
          </li>
        ))}
      </ul>
      <TipView tip={tip.tip} />
      <div className="viz-legend">
        <span>
          <i className="swatch you" /> You
        </span>
        <span>
          <i className="swatch agents" /> Assistants
        </span>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------- growth

function Growth({ growth }: { growth: InsightsData['growth'] }) {
  const tip = useTip();
  const box = useRef<HTMLDivElement>(null);
  const [hover, setHover] = useState<number | null>(null);
  const points = useMemo(() => {
    const out: { month: string; pages: number; words: number; added: number }[] = [];
    for (const g of growth) {
      const prev = out[out.length - 1];
      out.push({
        month: g.month,
        pages: (prev?.pages ?? 0) + g.pages,
        words: (prev?.words ?? 0) + (g.words ?? 0),
        added: g.pages,
      });
    }
    return out;
  }, [growth]);
  if (points.length < 2)
    return <p className="muted">Come back after a couple of months of writing.</p>;

  const W = 640;
  const H = 200;
  const pad = { l: 36, r: 56, t: 10, b: 24 };
  const maxY = niceMax(points[points.length - 1]!.pages);
  const x = (i: number) => pad.l + (i / (points.length - 1)) * (W - pad.l - pad.r);
  const y = (v: number) => pad.t + (1 - v / maxY) * (H - pad.t - pad.b);
  const line = points.map((p, i) => `${i ? 'L' : 'M'}${x(i)},${y(p.pages)}`).join(' ');
  const area = `${line} L${x(points.length - 1)},${y(0)} L${x(0)},${y(0)} Z`;
  const ticks = [0, maxY / 2, maxY];
  const label = (m: string) =>
    new Date(`${m}-15T12:00:00`).toLocaleDateString(undefined, { month: 'short', year: '2-digit' });
  const step = Math.ceil(points.length / 6);
  const last = points[points.length - 1]!;

  function move(e: React.PointerEvent<SVGRectElement>) {
    const r = e.currentTarget.getBoundingClientRect();
    const fx = ((e.clientX - r.left) / r.width) * (W - pad.l - pad.r);
    const i = Math.max(
      0,
      Math.min(points.length - 1, Math.round((fx / (W - pad.l - pad.r)) * (points.length - 1))),
    );
    setHover(i);
    const frame = box.current?.getBoundingClientRect();
    const svg = e.currentTarget.ownerSVGElement?.getBoundingClientRect();
    if (!frame || !svg) return;
    const p = points[i]!;
    tip.setTip({
      x: svg.left - frame.left + (x(i) / W) * svg.width,
      y: svg.top - frame.top + (y(p.pages) / H) * svg.height,
      content: (
        <>
          <b>{label(p.month)}</b>
          <br />
          {plural(p.pages, 'page')} ({p.added ? `+${fmt(p.added)}` : 'no new'}) · {fmt(p.words)}{' '}
          words
        </>
      ),
    });
  }

  return (
    <>
      <p className="sub">
        Pages that exist today, by the month they were made. {fmt(last.words)} words in all.
      </p>
      <div
        className="viz growth"
        ref={box}
        onMouseLeave={() => {
          tip.hide();
          setHover(null);
        }}
      >
        <svg
          viewBox={`0 0 ${W} ${H}`}
          role="img"
          aria-label={`Pages over time, now ${fmt(last.pages)}.`}
        >
          {ticks.map((t) => (
            <g key={t}>
              <line className="grid" x1={pad.l} x2={W - pad.r} y1={y(t)} y2={y(t)} />
              <text className="axis" x={pad.l - 6} y={y(t) + 4} textAnchor="end">
                {t >= 10_000 ? compact.format(t) : fmt(t)}
              </text>
            </g>
          ))}
          {points.map((p, i) =>
            i % step === 0 || i === points.length - 1 ? (
              <text key={p.month} className="axis" x={x(i)} y={H - 6} textAnchor="middle">
                {label(p.month)}
              </text>
            ) : null,
          )}
          <path className="area" d={area} />
          <path className="line" d={line} />
          {hover !== null && (
            <line className="cross" x1={x(hover)} x2={x(hover)} y1={pad.t} y2={y(0)} />
          )}
          <circle className="dot" cx={x(points.length - 1)} cy={y(last.pages)} r={4} />
          {hover !== null && hover !== points.length - 1 && (
            <circle className="dot" cx={x(hover)} cy={y(points[hover]!.pages)} r={4} />
          )}
          <text className="end-label" x={x(points.length - 1) + 8} y={y(last.pages) + 4}>
            {fmt(last.pages)}
          </text>
          <rect
            x={pad.l}
            y={pad.t}
            width={W - pad.l - pad.r}
            height={H - pad.t - pad.b}
            fill="transparent"
            onPointerMove={move}
          />
        </svg>
        <TipView tip={tip.tip} />
      </div>
      <details className="viz-table">
        <summary>Show as a table</summary>
        <table>
          <thead>
            <tr>
              <th>Month</th>
              <th>Added</th>
              <th>Pages</th>
              <th>Words</th>
            </tr>
          </thead>
          <tbody>
            {points.map((p) => (
              <tr key={p.month}>
                <td>{label(p.month)}</td>
                <td>{fmt(p.added)}</td>
                <td>{fmt(p.pages)}</td>
                <td>{fmt(p.words)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </details>
    </>
  );
}

/** A round axis maximum at or above n. */
function niceMax(n: number): number {
  if (n <= 4) return 4;
  const mag = 10 ** Math.floor(Math.log10(n));
  for (const m of [1, 2, 2.5, 5, 10]) if (m * mag >= n) return m * mag;
  return 10 * mag;
}

const plural = (n: number, word: string) => `${n.toLocaleString()} ${word}${n === 1 ? '' : 's'}`;
