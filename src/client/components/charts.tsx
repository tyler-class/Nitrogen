// Small hand-drawn SVG charts styled by CSS classes so they follow the theme (same pattern as
// Ratio). Colours come from --viz-you / --viz-agents in viz.css.
import { useEffect, useRef, useState, type ReactNode } from 'react';

/** The element's content width, kept up to date (charts draw at real size, never scaled). */
export function useWidth<T extends HTMLElement>(fallback = 600) {
  const ref = useRef<T>(null);
  const [width, setWidth] = useState(fallback);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const ro = new ResizeObserver(([e]) => {
      const w = Math.round(e!.contentRect.width);
      if (w > 0) setWidth(w);
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  return [ref, width] as const;
}

export function Stat({ v, l, d }: { v: ReactNode; l: string; d?: ReactNode }) {
  return (
    <div className="stat">
      <div className="v">{v}</div>
      <div className="l">{l}</div>
      {d ? <div className="d">{d}</div> : null}
    </div>
  );
}

export interface Col {
  label: string;
  /** Stacked from the bottom: [you, assistants] or a single value. */
  values: number[];
  current?: boolean;
  title?: string;
}

const TONES = ['you', 'agents'];

export function Columns({
  data,
  height = 150,
  tones = TONES,
}: {
  data: Col[];
  height?: number;
  tones?: string[];
}) {
  // Drawn about as wide as a half-width card, so labels stay readable.
  const [box, W] = useWidth<HTMLDivElement>(380);
  const H = height,
    pl = 2,
    pb = 22,
    pt = 18;
  const total = (d: Col) => d.values.reduce((a, b) => a + b, 0);
  const max = Math.max(1, ...data.map(total));
  const bw = (W - pl * 2) / Math.max(1, data.length);
  // Narrow charts label every other bar.
  const every = bw < 26 ? 2 : 1;
  return (
    <div ref={box} className="chart-box">
      <svg className="chart" viewBox={`0 0 ${W} ${H}`} width={W} height={H} role="img">
        <line className="ax" x1={pl} x2={W - pl} y1={H - pb} y2={H - pb} />
        {data.map((d, i) => {
          const barW = Math.min(bw * 0.7, 36);
          const x = pl + i * bw + (bw - barW) / 2;
          const mid = x + barW / 2;
          let y = H - pb;
          const t = total(d);
          return (
            <g key={i} className={d.current ? 'current' : undefined}>
              <title>{d.title ?? `${d.label}: ${t}`}</title>
              {d.values.map((v, j) => {
                const h = ((H - pb - pt) * v) / max;
                y -= h;
                return v > 0 ? (
                  <rect
                    key={j}
                    className={`bar-${tones[j] ?? 'you'}`}
                    x={x}
                    y={y}
                    width={barW}
                    height={Math.max(h, 2)}
                    rx={4}
                  />
                ) : null;
              })}
              {t > 0 && (
                <text className="vl" x={mid} y={y - 5} textAnchor="middle">
                  {t}
                </text>
              )}
              {(i % every === 0 || i === data.length - 1) && (
                <text x={mid} y={H - 7} textAnchor="middle">
                  {d.label}
                </text>
              )}
            </g>
          );
        })}
      </svg>
    </div>
  );
}

const MO = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

/** UTC date key, matching how the server groups events. */
export const dayKey = (d: Date) =>
  new Date(Date.UTC(d.getFullYear(), d.getMonth(), d.getDate())).toISOString().slice(0, 10);

/** Edits per day, GitHub-style. */
export function Heatmap({
  counts,
  weeks: fixed,
  tone = 'you',
  onWeeks,
}: {
  counts: Map<string, number>;
  /** Omit to fit as many weeks as the panel has room for (up to a year). */
  weeks?: number;
  tone?: string;
  onWeeks?: (n: number) => void;
}) {
  const [box, width] = useWidth<HTMLDivElement>(600);
  const weeks = fixed ?? Math.max(8, Math.min(53, Math.floor((width - 24 - 18) / 16)));
  useEffect(() => onWeeks?.(weeks), [weeks, onWeeks]);
  const now = new Date();
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const cell = 13,
    gap = 3,
    left = 24,
    top = 16;
  const start = new Date(
    today.getFullYear(),
    today.getMonth(),
    today.getDate() - today.getDay() - (weeks - 1) * 7,
  );
  const max = Math.max(1, ...counts.values());
  const level = (c: number) => (c ? Math.min(4, Math.ceil((c / max) * 4)) : 0);
  const cells: { x: number; y: number; c: number; t: string }[] = [];
  const months: { x: number; t: string }[] = [];
  for (let w = 0; w < weeks; w++) {
    for (let d = 0; d < 7; d++) {
      const dt = new Date(start.getFullYear(), start.getMonth(), start.getDate() + w * 7 + d);
      if (dt > today) continue;
      const c = counts.get(dayKey(dt)) ?? 0;
      cells.push({
        x: left + w * (cell + gap),
        y: top + d * (cell + gap),
        c,
        t: `${MO[dt.getMonth()]} ${dt.getDate()}: ${c} ${c === 1 ? 'edit' : 'edits'}`,
      });
      if (d === 0 && dt.getDate() <= 7)
        months.push({ x: left + w * (cell + gap), t: MO[dt.getMonth()]! });
    }
  }
  const W = left + weeks * (cell + gap) + 18,
    H = top + 7 * (cell + gap);
  return (
    <div ref={box} className="chart-box">
      <svg
        className={`chart heat tone-${tone}`}
        viewBox={`0 0 ${W} ${H}`}
        width={W}
        height={H}
        role="img"
      >
        {months.map((m, i) => (
          <text key={i} x={m.x} y={10}>
            {m.t}
          </text>
        ))}
        {[1, 3, 5].map((d) => (
          <text key={d} x={0} y={top + d * (cell + gap) + 10}>
            {'SMTWTFS'.charAt(d)}
          </text>
        ))}
        {cells.map((c, i) => (
          <rect
            key={i}
            className={`h${level(c.c)}`}
            x={c.x}
            y={c.y}
            width={cell}
            height={cell}
            rx={3}
          >
            <title>{c.t}</title>
          </rect>
        ))}
      </svg>
    </div>
  );
}

export interface RankRow {
  key: string;
  label: ReactNode;
  value: number;
  vl: string;
  sub?: string;
  tone?: string;
  href?: string;
}

/** Labelled horizontal bars; rows with href are links. */
export function Rank({
  rows,
  max,
  link,
}: {
  rows: RankRow[];
  max: number;
  link?: (row: RankRow, body: ReactNode) => ReactNode;
}) {
  return (
    <div className="rank">
      {rows.map((r) => {
        const body = (
          <>
            <div className="rk-top">
              <span className="rk-l">{r.label}</span>
              <span className="rk-v">{r.vl}</span>
            </div>
            <div className="bar">
              <i
                className={r.tone ? `tone-${r.tone}` : undefined}
                style={{ width: `${max ? Math.min(100, (r.value / max) * 100) : 0}%` }}
              />
            </div>
            {r.sub ? <div className="rk-s">{r.sub}</div> : null}
          </>
        );
        return (
          <div className="rk" key={r.key}>
            {r.href && link ? link(r, body) : body}
          </div>
        );
      })}
    </div>
  );
}

export function Chips<K extends string>({
  options,
  value,
  onChange,
  label,
}: {
  options: readonly (readonly [K, string])[];
  value: K;
  onChange: (k: K) => void;
  label: string;
}) {
  return (
    <div className="seg" role="radiogroup" aria-label={label}>
      {options.map(([k, l]) => (
        <button
          key={k}
          type="button"
          role="radio"
          aria-checked={value === k}
          className={value === k ? 'on' : ''}
          onClick={() => onChange(k)}
        >
          {l}
        </button>
      ))}
    </div>
  );
}
