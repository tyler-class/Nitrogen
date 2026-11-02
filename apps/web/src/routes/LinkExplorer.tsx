import { useEffect, useMemo, useRef, useState } from 'react';
import { Link, useNavigate } from '@tanstack/react-router';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { api, qs } from '../api/client.ts';
import { useTree } from '../api/hooks.ts';
import type { LinkGroup } from '../api/types.ts';
import { Drawer } from '../components/Drawer.tsx';
import { linkMention } from '@nitrogen/core';
import { toast } from '../lib/toast.ts';
import { setKV } from '../lib/db.ts';

export interface ExplorerSearch {
  page?: string;
  lens?: 'list' | 'matrix' | 'graph';
  dir?: 'in' | 'out' | 'both';
  rel?: string;
  rows?: string;
  cols?: string;
  depth?: '1' | '2';
  under?: string;
  tag?: string;
  status?: string;
}

const REL_DASH: Record<string, string> = { supersedes: '6 4', contradicts: '2 3', 'depends-on': '1 0', implements: '1 0', cites: '4 2', related: '1 0' };
const REL_COLOR: Record<string, string> = { supersedes: 'var(--warn)', contradicts: 'var(--danger)', 'depends-on': 'var(--info)', implements: 'var(--accent)', cites: 'var(--claude)', related: 'var(--faint)' };

function useNav(search: ExplorerSearch) {
  const navigate = useNavigate();
  return (patch: Partial<ExplorerSearch>) => {
    const next = { ...search, ...patch };
    void setKV('explorer-last', next);
    void navigate({ to: '/links', search: Object.fromEntries(Object.entries(next).filter(([, v]) => v !== undefined && v !== '')) as never, replace: true });
  };
}

export function LinkExplorer({ search }: { search: ExplorerSearch }) {
  const tree = useTree();
  const set = useNav(search);
  const relations = tree.data?.config.link_relations ?? ['related'];
  const rels = (search.rel ?? '').split(',').filter(Boolean);
  const lens = search.lens ?? 'list';
  const toggleRel = (r: string) => set({ rel: (rels.includes(r) ? rels.filter((x) => x !== r) : [...rels, r]).join(',') });
  return (
    <div className="page wide">
      <h1 className="page-title">Link explorer</h1>
      <div className="toolbar">
        <label className="sr-only" htmlFor="focus-page">Focus page</label>
        <select id="focus-page" className="input" style={{ width: 'auto', maxWidth: '100%' }} value={search.page ?? ''} onChange={(e) => set({ page: e.target.value })}>
          <option value="">Choose a page…</option>
          {tree.data?.pages.map((p) => <option key={p.path} value={p.path}>{p.title} (/{p.path})</option>)}
        </select>
        <div role="group" aria-label="Relations" style={{ display: 'flex', gap: 4, flexWrap: 'wrap' }}>
          {relations.map((r) => (
            <button key={r} className="chip-toggle" aria-pressed={rels.includes(r)} onClick={() => toggleRel(r)}>{r}</button>
          ))}
        </div>
      </div>
      <div className="tabs" role="tablist">
        {(['list', 'matrix', 'graph'] as const).map((l) => (
          <button key={l} role="tab" aria-selected={lens === l} onClick={() => set({ lens: l })}>{{ list: 'List', matrix: 'Cross view', graph: 'Neighborhood' }[l]}</button>
        ))}
      </div>
      {lens === 'list' && (search.page ? <ListLens search={search} set={set} /> : <p className="empty">Choose a page to see its links.</p>)}
      {lens === 'matrix' && <MatrixLens search={search} set={set} />}
      {lens === 'graph' && (search.page ? <GraphLens search={search} set={set} /> : <p className="empty">Choose a page to see its neighborhood.</p>)}
    </div>
  );
}

function Groups({ groups, title, emptyText }: { groups: (LinkGroup & { links: (LinkGroup['links'][number] & { broken?: boolean })[] })[] | undefined; title: string; emptyText: string }) {
  return (
    <section>
      <h2 style={{ fontSize: 18 }}>{title} {groups && <span className="chip">{groups.reduce((n, g) => n + g.count, 0)}</span>}</h2>
      {!groups ? <div className="skeleton-line" /> : groups.length === 0 ? <p style={{ color: 'var(--faint)' }}>{emptyText}</p> : (
        <ul className="list-plain">
          {groups.map((g) => (
            <li key={g.path}>
              {g.title ? <Link to="/p/$" params={{ _splat: g.path }} style={{ fontWeight: 600 }}>{g.title}</Link> : <span style={{ color: 'var(--danger)' }}>/{g.path} (missing) <Link to="/new" search={{ path: g.path }}>Create page</Link></span>}{' '}
              <span className="chip">{g.count}</span>
              {g.links.map((l, i) => (
                <p key={i} className="backlink-ctx">
                  {l.rel !== 'related' && <span className="chip rel">{l.rel}</span>}{' '}
                  <Link to="/p/$" params={{ _splat: title === 'Incoming' ? g.path : g.path }} hash={l.frag ?? undefined}>{l.ctx || l.text}</Link>
                </p>
              ))}
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

function ListLens({ search, set }: { search: ExplorerSearch; set: (p: Partial<ExplorerSearch>) => void }) {
  const dir = search.dir ?? 'both';
  const q = useQuery({
    queryKey: ['links', search.page, dir, search.rel, search.under, search.tag, search.status],
    queryFn: () => api<{ incoming?: LinkGroup[]; outgoing?: LinkGroup[] }>(`/links${qs({ page: search.page, dir, rel: search.rel, under: search.under, tag: search.tag, status: search.status })}`),
  });
  const [compare, setCompare] = useState(false);
  return (
    <>
      <div className="toolbar">
        <div role="group" aria-label="Direction" style={{ display: 'flex', gap: 4 }}>
          {(['in', 'out', 'both'] as const).map((d) => <button key={d} className="chip-toggle" aria-pressed={dir === d} onClick={() => set({ dir: d })}>{{ in: 'Incoming', out: 'Outgoing', both: 'Both' }[d]}</button>)}
        </div>
        <input className="input" style={{ width: 160 }} placeholder="Folder filter" defaultValue={search.under} onBlur={(e) => set({ under: e.target.value })} aria-label="Folder filter" />
        <input className="input" style={{ width: 120 }} placeholder="Tag" defaultValue={search.tag} onBlur={(e) => set({ tag: e.target.value })} aria-label="Tag filter" />
        <button className="btn" onClick={() => setCompare(true)}>Compare…</button>
      </div>
      {dir !== 'out' && <Groups groups={q.data?.incoming} title="Incoming" emptyText="Nothing links here." />}
      {dir !== 'out' && <Unlinked page={search.page!} />}
      {dir !== 'in' && <Groups groups={q.data?.outgoing} title="Outgoing" emptyText="This page links nowhere." />}
      {compare && <CompareDrawer a={search.page!} onClose={() => setCompare(false)} />}
    </>
  );
}

function Unlinked({ page }: { page: string }) {
  const qc = useQueryClient();
  const tree = useTree();
  const q = useQuery({ queryKey: ['unlinked', page], queryFn: () => api<{ mentions: { path: string; title: string; mention: string; snippet: string }[] }>(`/unlinked${qs({ page })}`) });
  const linkIt = async (m: { path: string; mention: string }) => {
    try {
      const src = await api<{ content: string; sha: string }>(`/page${qs({ path: m.path, include: 'content' })}`);
      const r = linkMention(src.content, m.mention, page);
      if (!r) return toast('That mention is inside code, a heading or a link. Edit the page instead.');
      await api('/commit', { method: 'POST', json: { changes: [{ path: m.path, op: 'put', content: r.src, baseSha: src.sha }], message: `nitrogen: link mention of ${tree.data?.pages.find((p) => p.path === page)?.title ?? page} in ${m.path}` } });
      toast('Linked. 1 file committed.');
      await qc.invalidateQueries({ queryKey: ['unlinked', page] });
      await qc.invalidateQueries({ queryKey: ['links'] });
      await qc.invalidateQueries({ queryKey: ['page', page] });
    } catch (e) {
      toast((e as Error).message);
    }
  };
  if (!q.data?.mentions.length) return null;
  return (
    <section>
      <h2 style={{ fontSize: 18 }}>Unlinked mentions <span className="chip">{q.data.mentions.length}</span></h2>
      <ul className="list-plain">
        {q.data.mentions.map((m) => (
          <li key={m.path} style={{ display: 'flex', gap: 12, alignItems: 'flex-start' }}>
            <div style={{ flex: 1 }}>
              <Link to="/p/$" params={{ _splat: m.path }} style={{ fontWeight: 600 }}>{m.title}</Link>
              <p className="backlink-ctx">{m.snippet.replace(/<<|>>/g, '')}</p>
            </div>
            <button className="btn" onClick={() => void linkIt(m)}>Link it</button>
          </li>
        ))}
      </ul>
    </section>
  );
}

function CompareDrawer({ a, onClose }: { a: string; onClose: () => void }) {
  const tree = useTree();
  const [b, setB] = useState('');
  const q = useQuery({ queryKey: ['compare', a, b], queryFn: () => api<{ coCitation: { path: string; title: string }[]; sharedReferences: { path: string; title: string | null }[]; path: { path: string; via: string | null }[] | null }>(`/compare${qs({ a, b })}`), enabled: !!b });
  const title = (p: string) => tree.data?.pages.find((x) => x.path === p)?.title ?? p;
  return (
    <Drawer title="Compare pages" onClose={onClose}>
      <label>Compare {title(a)} with{' '}
        <select className="input" value={b} onChange={(e) => setB(e.target.value)}>
          <option value="">Choose…</option>
          {tree.data?.pages.filter((p) => p.path !== a).map((p) => <option key={p.path} value={p.path}>{p.title}</option>)}
        </select>
      </label>
      {q.data && (
        <>
          <h3>Pages that link to both</h3>
          {q.data.coCitation.length ? <ul>{q.data.coCitation.map((x) => <li key={x.path}><Link to="/p/$" params={{ _splat: x.path }}>{x.title}</Link></li>)}</ul> : <p className="backlink-ctx">None.</p>}
          <h3>Pages both link to</h3>
          {q.data.sharedReferences.length ? <ul>{q.data.sharedReferences.map((x) => <li key={x.path}>{x.title ?? x.path}</li>)}</ul> : <p className="backlink-ctx">None.</p>}
          <h3>Shortest link path</h3>
          {q.data.path ? <ol>{q.data.path.map((s, i) => <li key={i}>{s.via ? (s.via === 'out' ? 'links to ' : 'is linked from ') : ''}{title(s.path)}</li>)}</ol> : <p className="backlink-ctx">No path within 4 links.</p>}
        </>
      )}
    </Drawer>
  );
}

interface MatrixData {
  tooLarge: boolean;
  cap?: number;
  rows: { path: string; title: string }[];
  cols: { path: string; title: string }[];
  cells: { src: string; dst: string; n: number }[];
  rowTotals: Record<string, number>;
  colTotals: Record<string, number>;
  emptyRows: string[];
  emptyCols: string[];
}

function SelectorInput({ label, value, onChange }: { label: string; value: string | undefined; onChange: (v: string) => void }) {
  return (
    <label style={{ fontSize: 14 }}>{label}{' '}
      <input className="input" style={{ width: 220 }} defaultValue={value} placeholder="under:decisions or tag:x" onBlur={(e) => onChange(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && onChange(e.currentTarget.value)} />
    </label>
  );
}

function MatrixLens({ search, set }: { search: ExplorerSearch; set: (p: Partial<ExplorerSearch>) => void }) {
  const rows = search.rows ?? '';
  const cols = search.cols ?? '';
  const q = useQuery({ queryKey: ['matrix', rows, cols, search.rel], queryFn: () => api<MatrixData>(`/matrix${qs({ rows, cols, rel: search.rel })}`) });
  const [cell, setCell] = useState<{ src: string; dst: string } | null>(null);
  const tableRef = useRef<HTMLTableElement>(null);
  const counts = useMemo(() => new Map((q.data?.cells ?? []).map((c) => [`${c.src}|${c.dst}`, c.n])), [q.data]);
  const max = Math.max(1, ...(q.data?.cells ?? []).map((c) => c.n));
  const move = (e: React.KeyboardEvent, r: number, c: number) => {
    const d = { ArrowRight: [0, 1], ArrowLeft: [0, -1], ArrowDown: [1, 0], ArrowUp: [-1, 0] }[e.key];
    if (!d) return;
    e.preventDefault();
    (tableRef.current?.querySelector(`[data-rc="${r + d[0]!}-${c + d[1]!}"]`) as HTMLElement | null)?.focus();
  };
  const data = q.data;
  return (
    <>
      <div className="toolbar">
        <SelectorInput label="Rows (sources)" value={rows} onChange={(v) => set({ rows: v })} />
        <SelectorInput label="Columns (targets)" value={cols} onChange={(v) => set({ cols: v })} />
      </div>
      {!data ? <div className="skeleton-line" /> : data.tooLarge ? <p className="empty">More than {data.cap} pages on an axis. Narrow the rows or columns.</p> : (
        <>
          {(data.emptyRows.length > 0 || data.emptyCols.length > 0) && (
            <p className="backlink-ctx" role="note">
              {data.emptyRows.length > 0 && <>No links out of: {data.emptyRows.map((p) => data.rows.find((r) => r.path === p)?.title).join(', ')}. </>}
              {data.emptyCols.length > 0 && <>Nothing links to: {data.emptyCols.map((p) => data.cols.find((c) => c.path === p)?.title).join(', ')}.</>}
            </p>
          )}
          <div className="matrix-wrap">
            <table className="matrix" ref={tableRef}>
              <caption className="sr-only">Links from row pages to column pages</caption>
              <thead>
                <tr>
                  <th scope="col" style={{ writingMode: 'horizontal-tb', transform: 'none' }}>From \ To</th>
                  {data.cols.map((c) => <th key={c.path} scope="col"><button onClick={() => set({ page: c.path, lens: 'list' })}>{c.title}</button></th>)}
                  <th scope="col">Total</th>
                </tr>
              </thead>
              <tbody>
                {data.rows.map((r, ri) => (
                  <tr key={r.path} className={data.emptyRows.includes(r.path) ? 'empty-row' : undefined}>
                    <th scope="row"><button onClick={() => set({ page: r.path, lens: 'list' })}>{r.title}</button></th>
                    {data.cols.map((c, ci) => {
                      const n = counts.get(`${r.path}|${c.path}`) ?? 0;
                      return (
                        <td key={c.path} style={n ? { background: `color-mix(in srgb, var(--accent) ${Math.round(15 + (60 * n) / max)}%, transparent)` } : undefined}>
                          <button data-rc={`${ri}-${ci}`} tabIndex={ri === 0 && ci === 0 ? 0 : -1} aria-label={`${r.title} links to ${c.title}: ${n}`} onKeyDown={(e) => move(e, ri, ci)} onClick={() => n && setCell({ src: r.path, dst: c.path })} style={{ color: n ? 'var(--ink)' : 'var(--faint)' }}>
                            {n || '·'}
                          </button>
                        </td>
                      );
                    })}
                    <td><strong>{data.rowTotals[r.path] ?? 0}</strong></td>
                  </tr>
                ))}
                <tr>
                  <th scope="row">Total</th>
                  {data.cols.map((c) => <td key={c.path}><strong>{data.colTotals[c.path] ?? 0}</strong></td>)}
                  <td />
                </tr>
              </tbody>
            </table>
          </div>
        </>
      )}
      {cell && <CellDrawer {...cell} rel={search.rel} onClose={() => setCell(null)} />}
    </>
  );
}

function CellDrawer({ src, dst, rel, onClose }: { src: string; dst: string; rel?: string; onClose: () => void }) {
  const tree = useTree();
  const q = useQuery({ queryKey: ['cell', src, dst, rel], queryFn: () => api<{ links: { rel: string; text: string; ctx: string; frag: string | null; line: number }[] }>(`/matrix/cell${qs({ src, dst, rel })}`) });
  const t = (p: string) => tree.data?.pages.find((x) => x.path === p)?.title ?? p;
  return (
    <Drawer title={`${t(src)} → ${t(dst)}`} onClose={onClose}>
      <ul className="list-plain">
        {q.data?.links.map((l, i) => (
          <li key={i}><span className="chip rel">{l.rel}</span> <Link to="/p/$" params={{ _splat: src }}>{l.ctx}</Link> <small style={{ color: 'var(--faint)' }}>line {l.line}</small></li>
        ))}
      </ul>
    </Drawer>
  );
}

interface Hood {
  center: string;
  nodes: { path: string; title: string; excerpt: string; missing: boolean }[];
  edges: { src: string; dst: string; rel: string; n: number }[];
  truncated: boolean;
}

/** Deterministic layout: radial for one hop; seeded force layout for two. */
export function layout(h: Hood, depth: 1 | 2, size = 560): Map<string, { x: number; y: number }> {
  const pos = new Map<string, { x: number; y: number }>();
  const c = size / 2;
  pos.set(h.center, { x: c, y: c });
  const others = h.nodes.filter((n) => n.path !== h.center).map((n) => n.path).sort();
  const first = new Set(h.edges.flatMap((e) => (e.src === h.center ? [e.dst] : e.dst === h.center ? [e.src] : [])));
  const ring1 = others.filter((p) => first.has(p));
  const ring2 = others.filter((p) => !first.has(p));
  ring1.forEach((p, i) => {
    const a = (2 * Math.PI * i) / Math.max(ring1.length, 1) - Math.PI / 2;
    pos.set(p, { x: c + Math.cos(a) * size * 0.3, y: c + Math.sin(a) * size * 0.3 });
  });
  ring2.forEach((p, i) => {
    const a = (2 * Math.PI * i) / Math.max(ring2.length, 1) - Math.PI / 2 + 0.3;
    pos.set(p, { x: c + Math.cos(a) * size * 0.46, y: c + Math.sin(a) * size * 0.46 });
  });
  if (depth === 2) {
    // A few seeded relaxation passes (no randomness: deterministic).
    for (let it = 0; it < 60; it++) {
      for (const a of others) {
        const pa = pos.get(a)!;
        let fx = 0;
        let fy = 0;
        for (const b of h.nodes) {
          if (b.path === a) continue;
          const pb = pos.get(b.path)!;
          const dx = pa.x - pb.x;
          const dy = pa.y - pb.y;
          const d2 = Math.max(dx * dx + dy * dy, 25);
          fx += (dx / d2) * 900;
          fy += (dy / d2) * 900;
        }
        for (const e of h.edges) {
          const o = e.src === a ? e.dst : e.dst === a ? e.src : null;
          if (!o) continue;
          const pb = pos.get(o)!;
          fx -= (pa.x - pb.x) * 0.01;
          fy -= (pa.y - pb.y) * 0.01;
        }
        pa.x = Math.min(size - 20, Math.max(20, pa.x + fx));
        pa.y = Math.min(size - 20, Math.max(20, pa.y + fy));
      }
    }
  }
  return pos;
}

function GraphLens({ search, set }: { search: ExplorerSearch; set: (p: Partial<ExplorerSearch>) => void }) {
  const depth = search.depth === '2' ? 2 : 1;
  const navigate = useNavigate();
  const [limit, setLimit] = useState(40);
  const q = useQuery({ queryKey: ['hood', search.page, depth, search.rel, limit], queryFn: () => api<Hood>(`/neighborhood${qs({ page: search.page, depth, rel: search.rel, limit })}`), staleTime: 60_000 });
  const [hover, setHover] = useState<string | null>(null);
  useEffect(() => setHover(null), [search.page]);
  const size = 560;
  const data = q.data;
  const pos = useMemo(() => (data ? layout(data, depth, size) : null), [data, depth]);
  const title = (p: string) => data?.nodes.find((n) => n.path === p)?.title ?? p;
  return (
    <>
      <div className="toolbar">
        <button className="chip-toggle" aria-pressed={depth === 1} onClick={() => set({ depth: '1' })}>One hop</button>
        <button className="chip-toggle" aria-pressed={depth === 2} onClick={() => set({ depth: '2' })}>Two hops</button>
        {data?.truncated && <button className="btn" onClick={() => setLimit((l) => l + 40)}>Show more</button>}
      </div>
      {!data || !pos ? <div className="skeleton-line" style={{ height: 300 }} /> : (
        <div className="graph">
          <svg viewBox={`0 0 ${size} ${size}`} role="img" aria-label={`Link neighborhood of ${title(data.center)}: ${data.nodes.length - 1} connected pages. A text list follows.`}>
            <defs>
              <marker id="arrow" viewBox="0 0 10 10" refX="22" refY="5" markerWidth="6" markerHeight="6" orient="auto-start-reverse"><path d="M0 0 10 5 0 10z" fill="var(--muted)" /></marker>
            </defs>
            {data.edges.map((e, i) => {
              const a = pos.get(e.src);
              const b = pos.get(e.dst);
              if (!a || !b) return null;
              const twoWay = data.edges.some((x) => x.src === e.dst && x.dst === e.src);
              const off = twoWay ? 6 : 0;
              return <line key={i} x1={a.x + off} y1={a.y + off} x2={b.x + off} y2={b.y + off} stroke={REL_COLOR[e.rel] ?? 'var(--faint)'} strokeWidth={1.5} strokeDasharray={REL_DASH[e.rel] ?? '1 0'} markerEnd="url(#arrow)" opacity={hover && hover !== e.src && hover !== e.dst ? 0.2 : 0.9}><title>{`${title(e.src)} ${e.rel} ${title(e.dst)}`}</title></line>;
            })}
            {data.nodes.map((n) => {
              const p = pos.get(n.path)!;
              const center = n.path === data.center;
              return (
                <g key={n.path} className="node" tabIndex={0} role="button" aria-label={`${n.title}${center ? ' (center)' : ''}. Enter opens, Space recenters.`} transform={`translate(${p.x},${p.y})`}
                  onClick={() => set({ page: n.path })}
                  onDoubleClick={() => void navigate({ to: '/p/$', params: { _splat: n.path } })}
                  onKeyDown={(e) => { if (e.key === 'Enter') void navigate({ to: '/p/$', params: { _splat: n.path } }); if (e.key === ' ') { e.preventDefault(); set({ page: n.path }); } }}
                  onMouseEnter={() => setHover(n.path)} onMouseLeave={() => setHover(null)} onFocus={() => setHover(n.path)}>
                  <circle r={center ? 14 : 9} fill={n.missing ? 'var(--danger-soft)' : center ? 'var(--accent)' : 'var(--paper)'} stroke={center ? 'var(--accent-ink)' : 'var(--muted)'} strokeWidth={1.5} />
                  <text y={center ? 30 : 24} textAnchor="middle" fontSize={12} fill="var(--ink)">{n.title.length > 26 ? `${n.title.slice(0, 25)}…` : n.title}</text>
                  <title>{`${n.title}${n.excerpt ? `: ${n.excerpt}` : ''}`}</title>
                </g>
              );
            })}
          </svg>
          <h2 style={{ fontSize: 16 }}>Neighbors of {title(data.center)}</h2>
          <ul>
            {data.edges.filter((e) => e.src === data.center || e.dst === data.center).map((e, i) => (
              <li key={i}>{e.src === data.center ? <>links to <Link to="/p/$" params={{ _splat: e.dst }}>{title(e.dst)}</Link></> : <>linked from <Link to="/p/$" params={{ _splat: e.src }}>{title(e.src)}</Link></>} <span className="chip rel">{e.rel}</span>{e.n > 1 ? ` ×${e.n}` : ''}</li>
            ))}
          </ul>
        </div>
      )}
    </>
  );
}
