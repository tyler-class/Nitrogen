// The local graph: a page, the pages it links with, and theirs. A small deterministic
// force layout (no library); the centre stays in the middle.
import '../styles/graph.css';
import { useEffect, useMemo, useRef, useState } from 'react';
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

interface View {
  k: number;
  x: number;
  y: number;
}
const DEFAULT_ZOOM = 1.3;
const MIN_ZOOM = 0.5;
const MAX_ZOOM = 4;

/** Zoomed in a little, with the centre page in the middle. */
const initialView = (c: { x: number; y: number }): View => ({
  k: DEFAULT_ZOOM,
  x: W / 2 - c.x * DEFAULT_ZOOM,
  y: H / 2 - c.y * DEFAULT_ZOOM,
});

export function GraphView({
  graph,
  onOpen,
  onSelect,
  colorOf,
}: {
  graph: Graph;
  /** Double-click (or Enter): open the page. */
  onOpen(id: string): void;
  /** Click: explore from this page. Without it a click opens the page. */
  onSelect?(id: string): void;
  /** Fill colour per page (e.g. by top-level area). */
  colorOf?(id: string): string | undefined;
}) {
  const pos = useMemo(() => layout(graph), [graph]);
  const center = pos.get(graph.center) ?? { x: W / 2, y: H / 2 };
  const [view, setView] = useState<View>(() => initialView(center));
  const [hover, setHover] = useState<string | null>(null);
  const svg = useRef<SVGSVGElement>(null);
  const pointers = useRef(new Map<number, { x: number; y: number }>());
  const gesture = useRef<{ dist: number; view: View; mid: { x: number; y: number } } | null>(null);
  const moved = useRef(false);
  const downOn = useRef<string | null>(null);

  // Neighbours of the hovered page, for highlighting and stacking order.
  const nbrs = useMemo(() => {
    const out = new Set<string>();
    if (!hover) return out;
    for (const e of graph.edges) {
      if (e.source === hover) out.add(e.target);
      if (e.target === hover) out.add(e.source);
    }
    return out;
  }, [hover, graph.edges]);

  /** Client point → viewBox point. */
  const toBox = (clientX: number, clientY: number) => {
    const r = svg.current!.getBoundingClientRect();
    return { x: ((clientX - r.left) / r.width) * W, y: ((clientY - r.top) / r.height) * H };
  };
  const zoomAt = (p: { x: number; y: number }, k: number, from: View = view): View => {
    const nk = Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, k));
    return {
      k: nk,
      x: p.x - ((p.x - from.x) / from.k) * nk,
      y: p.y - ((p.y - from.y) / from.k) * nk,
    };
  };

  // Wheel zoom needs a non-passive listener so the sheet doesn't scroll instead.
  useEffect(() => {
    const el = svg.current;
    if (!el) return;
    const onWheel = (e: WheelEvent) => {
      e.preventDefault();
      const p = toBox(e.clientX, e.clientY);
      setView((v) => zoomAt(p, v.k * Math.exp(-e.deltaY * 0.0015), v));
    };
    el.addEventListener('wheel', onWheel, { passive: false });
    return () => el.removeEventListener('wheel', onWheel);
  });

  const onPointerDown = (e: React.PointerEvent) => {
    if ((e.target as Element).closest('.node')) return;
    (e.currentTarget as Element).setPointerCapture(e.pointerId);
    pointers.current.set(e.pointerId, { x: e.clientX, y: e.clientY });
    moved.current = false;
    if (pointers.current.size === 2) {
      const [a, b] = [...pointers.current.values()] as [
        { x: number; y: number },
        { x: number; y: number },
      ];
      gesture.current = {
        dist: Math.hypot(a.x - b.x, a.y - b.y),
        view,
        mid: toBox((a.x + b.x) / 2, (a.y + b.y) / 2),
      };
    }
  };
  const onPointerMove = (e: React.PointerEvent) => {
    const prev = pointers.current.get(e.pointerId);
    if (!prev) return;
    pointers.current.set(e.pointerId, { x: e.clientX, y: e.clientY });
    if (pointers.current.size === 2 && gesture.current) {
      const [a, b] = [...pointers.current.values()] as [
        { x: number; y: number },
        { x: number; y: number },
      ];
      const g = gesture.current;
      setView(zoomAt(g.mid, g.view.k * (Math.hypot(a.x - b.x, a.y - b.y) / g.dist), g.view));
      return;
    }
    const r = svg.current!.getBoundingClientRect();
    const dx = ((e.clientX - prev.x) / r.width) * W;
    const dy = ((e.clientY - prev.y) / r.height) * H;
    if (Math.abs(dx) + Math.abs(dy) > 0.5) moved.current = true;
    setView((v) => ({ ...v, x: v.x + dx, y: v.y + dy }));
  };
  const onPointerUp = (e: React.PointerEvent) => {
    pointers.current.delete(e.pointerId);
    if (pointers.current.size < 2) gesture.current = null;
  };
  const step = (f: number) => setView((v) => zoomAt({ x: W / 2, y: H / 2 }, v.k * f, v));

  if (graph.nodes.length < 2)
    return <p className="graph-note">No links to or from this page yet.</p>;

  const lit = (id: string) => id === hover || nbrs.has(id);
  const edgeLit = (s: string, t: string) => !!hover && (s === hover || t === hover);
  // Later elements paint on top: plain first, then the hovered page's links and neighbours.
  const edges = [...graph.edges].sort(
    (a, b) => Number(edgeLit(a.source, a.target)) - Number(edgeLit(b.source, b.target)),
  );
  const rank = (id: string) => (id === hover ? 3 : nbrs.has(id) ? 2 : id === graph.center ? 1 : 0);
  const nodes = [...graph.nodes].sort((a, b) => rank(a.id) - rank(b.id));

  return (
    <div className={`graph${hover ? ' hovering' : ''}`}>
      <svg
        ref={svg}
        viewBox={`0 0 ${W} ${H}`}
        preserveAspectRatio="xMidYMid meet"
        role="group"
        aria-label={`Pages connected to this one: ${graph.nodes.length - 1}.`}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onPointerCancel={onPointerUp}
      >
        <g transform={`translate(${view.x},${view.y}) scale(${view.k})`}>
          {edges.map((e) => {
            const a = pos.get(e.source);
            const b = pos.get(e.target);
            if (!a || !b) return null;
            const on = edgeLit(e.source, e.target);
            return (
              <line
                key={`${e.source}-${e.target}`}
                className={`edge ${e.kind}${on ? ' lit' : ''}`}
                x1={a.x}
                y1={a.y}
                x2={b.x}
                y2={b.y}
              />
            );
          })}
          {nodes.map((n) => {
            const p = pos.get(n.id)!;
            const isCenter = n.id === graph.center;
            const on = lit(n.id);
            const name = `${n.icon ? `${n.icon} ` : ''}${n.title}`;
            return (
              <g
                key={n.id}
                className={`node${isCenter ? ' center' : ''}${n.depth >= 2 ? ' d2' : ''}${on ? ' lit' : ''}${n.id === hover ? ' hovered' : ''}`}
                transform={`translate(${p.x},${p.y})`}
                role="link"
                tabIndex={0}
                aria-label={n.title}
                onPointerEnter={() => setHover(n.id)}
                onPointerLeave={() => setHover((h) => (h === n.id ? null : h))}
                onFocus={() => setHover(n.id)}
                onBlur={() => setHover((h) => (h === n.id ? null : h))}
                // Selection on pointer-up, not click: hovering re-orders nodes (to draw them on
                // top), and moving an element between down and up cancels the browser's click.
                onPointerDown={() => {
                  downOn.current = n.id;
                }}
                onPointerUp={() => {
                  if (downOn.current !== n.id || moved.current) return;
                  downOn.current = null;
                  if (onSelect) onSelect(n.id);
                  else onOpen(n.id);
                }}
                onDoubleClick={() => onOpen(n.id)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' || e.key === ' ') {
                    e.preventDefault();
                    onOpen(n.id);
                  }
                }}
              >
                <circle
                  r={isCenter ? 10 : n.depth === 1 ? 7 : 5.5}
                  style={
                    colorOf?.(n.id)
                      ? ({ '--node': colorOf(n.id) } as React.CSSProperties)
                      : undefined
                  }
                />
                <text x={isCenter ? 14 : 10} y={4}>
                  {on || isCenter ? name : clip(name)}
                </text>
                <title>{n.title}</title>
              </g>
            );
          })}
        </g>
      </svg>
      <div className="graph-zoom" role="group" aria-label="Zoom">
        <button type="button" onClick={() => step(1.25)} aria-label="Zoom in">
          +
        </button>
        <button type="button" onClick={() => step(0.8)} aria-label="Zoom out">
          −
        </button>
        <button type="button" onClick={() => setView(initialView(center))} aria-label="Reset view">
          ⟲
        </button>
      </div>
      <p className="graph-note">
        {onSelect
          ? 'Click a page to explore from it, double-click to open it. Scroll or pinch to zoom, drag to move.'
          : 'Scroll or pinch to zoom, drag to move.'}{' '}
        Dashed lines are parent and subpages.
        {graph.truncated ? ' Showing the closest 60 pages.' : ''}
      </p>
    </div>
  );
}
