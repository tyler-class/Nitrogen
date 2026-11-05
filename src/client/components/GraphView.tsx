// The local graph: a page, the pages it links with, and theirs. A small deterministic
// force layout (no library); the centre stays in the middle.
import '../styles/insights.css';
import { useMemo } from 'react';
import type { Graph } from '@shared/types';

const W = 720;
const H = 420;

interface Pos {
  x: number;
  y: number;
  vx: number;
  vy: number;
}

/** Same graph → same picture: positions come from a seeded generator. */
function seeded(seed: number) {
  let s = seed >>> 0 || 1;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 2 ** 32;
  };
}

function hash(str: string) {
  let h = 2166136261;
  for (let i = 0; i < str.length; i++) h = Math.imul(h ^ str.charCodeAt(i), 16777619);
  return h >>> 0;
}

function layout(graph: Graph): Map<string, { x: number; y: number }> {
  const rand = seeded(hash(graph.center + graph.nodes.length));
  const cx = W / 2;
  const cy = H / 2;
  const pos = new Map<string, Pos>();
  graph.nodes.forEach((n, i) => {
    const angle = (i / Math.max(1, graph.nodes.length)) * Math.PI * 2 + rand() * 0.6;
    const r = n.depth === 0 ? 0 : n.depth * 110 + rand() * 30;
    pos.set(n.id, { x: cx + Math.cos(angle) * r, y: cy + Math.sin(angle) * r * 0.7, vx: 0, vy: 0 });
  });
  const depth = new Map(graph.nodes.map((n) => [n.id, n.depth]));
  const nodes = [...pos.entries()];
  const edges = graph.edges.filter((e) => pos.has(e.source) && pos.has(e.target));

  for (let it = 0; it < 300; it++) {
    const cool = 1 - it / 300;
    // Repulsion between every pair.
    for (let i = 0; i < nodes.length; i++) {
      const a = nodes[i]![1];
      for (let j = i + 1; j < nodes.length; j++) {
        const b = nodes[j]![1];
        let dx = a.x - b.x;
        let dy = a.y - b.y;
        let d2 = dx * dx + dy * dy;
        if (d2 < 1) {
          dx = rand() - 0.5;
          dy = rand() - 0.5;
          d2 = 1;
        }
        const f = 5200 / d2;
        const d = Math.sqrt(d2);
        a.vx += (dx / d) * f;
        a.vy += (dy / d) * f;
        b.vx -= (dx / d) * f;
        b.vy -= (dy / d) * f;
      }
    }
    // Springs along edges; first-hop links are shorter.
    for (const e of edges) {
      const a = pos.get(e.source)!;
      const b = pos.get(e.target)!;
      const dx = b.x - a.x;
      const dy = b.y - a.y;
      const d = Math.max(1, Math.hypot(dx, dy));
      const near = Math.min(depth.get(e.source) ?? 1, depth.get(e.target) ?? 1) === 0;
      const rest = near ? 120 : 95;
      const f = (d - rest) * 0.04;
      a.vx += (dx / d) * f;
      a.vy += (dy / d) * f;
      b.vx -= (dx / d) * f;
      b.vy -= (dy / d) * f;
    }
    // Gentle pull to the middle, stronger for further nodes so the picture stays compact.
    for (const [id, p] of nodes) {
      const k = 0.006 + 0.004 * (depth.get(id) ?? 1);
      p.vx += (cx - p.x) * k;
      p.vy += (cy - p.y) * k * 1.4;
    }
    for (const [id, p] of nodes) {
      if (id === graph.center) {
        p.x = cx;
        p.y = cy;
        p.vx = p.vy = 0;
        continue;
      }
      const max = 30 * cool + 2;
      p.x += Math.max(-max, Math.min(max, p.vx * 0.5));
      p.y += Math.max(-max, Math.min(max, p.vy * 0.5));
      p.vx *= 0.6;
      p.vy *= 0.6;
      p.x = Math.max(40, Math.min(W - 40, p.x));
      p.y = Math.max(24, Math.min(H - 24, p.y));
    }
  }
  return new Map(nodes.map(([id, p]) => [id, { x: p.x, y: p.y }]));
}

const clip = (s: string, n = 22) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);

export function GraphView({ graph, onOpen }: { graph: Graph; onOpen(id: string): void }) {
  const pos = useMemo(() => layout(graph), [graph]);
  if (graph.nodes.length < 2)
    return <p className="graph-note">No links to or from this page yet.</p>;
  return (
    <div className="graph">
      <svg
        viewBox={`0 0 ${W} ${H}`}
        preserveAspectRatio="xMidYMid meet"
        role="group"
        aria-label={`Pages connected to this one: ${graph.nodes.length - 1}.`}
      >
        {graph.edges.map((e) => {
          const a = pos.get(e.source);
          const b = pos.get(e.target);
          if (!a || !b) return null;
          return (
            <line
              key={`${e.source}-${e.target}`}
              className={`edge ${e.kind}`}
              x1={a.x}
              y1={a.y}
              x2={b.x}
              y2={b.y}
            />
          );
        })}
        {graph.nodes.map((n) => {
          const p = pos.get(n.id)!;
          const center = n.id === graph.center;
          const label = clip(`${n.icon ? `${n.icon} ` : ''}${n.title}`);
          return (
            <g
              key={n.id}
              className={`node${center ? ' center' : ''}${n.depth >= 2 ? ' d2' : ''}`}
              transform={`translate(${p.x},${p.y})`}
              role="link"
              tabIndex={0}
              aria-label={n.title}
              onClick={() => onOpen(n.id)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' || e.key === ' ') {
                  e.preventDefault();
                  onOpen(n.id);
                }
              }}
            >
              <circle r={center ? 9 : n.depth === 1 ? 6 : 5} />
              <text x={center ? 14 : 10} y={4}>
                {label}
              </text>
              <title>{n.title}</title>
            </g>
          );
        })}
      </svg>
      <p className="graph-note">
        Solid lines are links; dashed lines are the parent and subpages.
        {graph.truncated ? ' Showing the closest 60 pages.' : ''}
      </p>
    </div>
  );
}
