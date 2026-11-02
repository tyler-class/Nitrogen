import { Fragment, useMemo, useState, useEffect, useRef, type ReactNode, type ComponentProps } from 'react';
import { jsx, jsxs } from 'react/jsx-runtime';
import { toJsxRuntime } from 'hast-util-to-jsx-runtime';
import { renderToHast } from '@nitrogen/render';
import type { VaultContext } from '@nitrogen/core';
import { useNavigate } from '@tanstack/react-router';
import { Icon } from './Icon.tsx';
import { pageHref } from '../lib/tree.ts';
import { Drawer } from './Drawer.tsx';
import { Mermaid } from './Mermaid.tsx';

type P = Record<string, unknown> & { children?: ReactNode; node?: unknown };

function Callout(p: P) {
  const fold = String(p['data-fold'] ?? '');
  const [open, setOpen] = useState(fold !== '-');
  const title = String(p['data-title'] ?? '');
  const type = String(p['data-type'] ?? 'note');
  const unknown = p['data-unknown'] ? ` (unknown type "${String(p['data-unknown'])}")` : '';
  const head = fold ? (
    <button className="callout-title" aria-expanded={open} onClick={() => setOpen(!open)}>
      <Icon name="chevron" size={14} /> {title}
    </button>
  ) : (
    <p className="callout-title">{title}{unknown}</p>
  );
  return (
    <aside className="callout" data-type={type} data-collapsed={!open} role="note" aria-label={`${type}: ${title}`}>
      {head}
      <div className="callout-body">{p.children}</div>
    </aside>
  );
}

function DrawerButton(p: P) {
  const [open, setOpen] = useState(false);
  const title = String(p['data-title'] ?? 'Details');
  return (
    <>
      <button className="drawer-btn" onClick={() => setOpen(true)} aria-haspopup="dialog">
        <Icon name={p['data-icon'] === 'table' ? 'table' : 'panel'} /> {title}
      </button>
      {open && (
        <Drawer title={title} width={String(p['data-width'] ?? 'md')} onClose={() => setOpen(false)}>
          <div className="prose">{p.children}</div>
        </Drawer>
      )}
    </>
  );
}

function Img(p: P & { src?: string; alt?: string; title?: string }) {
  const [loaded, setLoaded] = useState(false);
  const [zoomed, setZoomed] = useState(false);
  if (p['data-external']) return <span className="chip" title="External images are blocked">External image: {p.alt}</span>;
  const w = String(p['data-w'] ?? '');
  const style = w ? { width: w.endsWith('%') ? w : `${w}px`, maxWidth: '100%' } : undefined;
  const h = String(p['data-h'] ?? '');
  const zoom = p['data-zoom'] !== 'false';
  return (
    <>
      {!loaded && <span className="img-skeleton" style={{ display: 'inline-block', width: style?.width ?? '100%' }} aria-hidden />}
      <img
        src={p.src}
        alt={p.alt}
        title={p.title}
        loading="lazy"
        decoding="async"
        style={{ ...style, ...(h ? { height: `${h}px`, objectFit: 'cover' as const } : {}), ...(loaded ? {} : { position: 'absolute', opacity: 0 }) }}
        data-zoom={String(zoom)}
        onLoad={() => setLoaded(true)}
        onClick={zoom ? () => setZoomed(true) : undefined}
      />
      {zoomed && (
        <div className="lightbox" role="dialog" aria-label={p.alt} onClick={() => setZoomed(false)} onKeyDown={(e) => e.key === 'Escape' && setZoomed(false)} tabIndex={-1} ref={(el) => el?.focus()}>
          <img src={p.src} alt={p.alt} />
        </div>
      )}
    </>
  );
}

function Figure(p: P) {
  const { children, node: _n, ...rest } = p;
  return <figure {...(rest as ComponentProps<'figure'>)}>{children}</figure>;
}

function sortRows(tbody: HTMLTableSectionElement, col: number, dir: 1 | -1) {
  const rows = [...tbody.rows];
  const coll = new Intl.Collator(undefined, { numeric: true });
  rows.sort((a, b) => dir * coll.compare(a.cells[col]?.textContent ?? '', b.cells[col]?.textContent ?? ''));
  rows.forEach((r) => tbody.appendChild(r));
}

function Table(p: P) {
  const ref = useRef<HTMLTableElement>(null);
  const [sort, setSort] = useState<{ col: number; dir: 1 | -1 } | null>(null);
  const widths = String(p['data-widths'] ?? '').split(',').filter(Boolean);
  const caption = String(p['data-caption'] ?? '');
  useEffect(() => {
    const t = ref.current;
    if (!t) return;
    const ths = [...t.querySelectorAll('thead th')] as HTMLTableCellElement[];
    ths.forEach((th, i) => {
      th.setAttribute('aria-sort', sort?.col === i ? (sort.dir === 1 ? 'ascending' : 'descending') : 'none');
      th.tabIndex = 0;
      th.onclick = () => setSort((s) => ({ col: i, dir: s?.col === i && s.dir === 1 ? -1 : 1 }));
      th.onkeydown = (e) => (e.key === 'Enter' || e.key === ' ') && (e.preventDefault(), th.click());
    });
    if (sort && t.tBodies[0]) sortRows(t.tBodies[0], sort.col, sort.dir);
  }, [sort]);
  return (
    <>
      {caption && <p className="table-caption" id={`cap-${caption.length}`}>{caption}</p>}
      <div className="table-wrap" data-style={String(p['data-style'] ?? 'plain')} data-header={String(p['data-header'] ?? 'normal')} data-dense={String(p['data-dense'] ?? 'false')} data-wrap={String(p['data-wrap'] ?? 'true')} tabIndex={0} role="region" aria-label={caption || 'Table'}>
        <table ref={ref}>
          {widths.length > 0 && <colgroup>{widths.map((w, i) => <col key={i} style={{ width: `${w}%` }} />)}</colgroup>}
          {p.children}
        </table>
      </div>
    </>
  );
}

function Pre(p: P) {
  const ref = useRef<HTMLPreElement>(null);
  const [copied, setCopied] = useState(false);
  return (
    <pre ref={ref}>
      <button className="icon-btn" style={{ position: 'absolute', top: 4, right: 4, width: 30, height: 30 }} aria-label="Copy code" onClick={() => { void navigator.clipboard?.writeText(ref.current?.querySelector('code')?.textContent ?? ''); setCopied(true); setTimeout(() => setCopied(false), 1200); }}>
        <Icon name={copied ? 'chevron' : 'copy'} size={14} />
      </button>
      {p.children}
    </pre>
  );
}

function Wikilink(p: P) {
  const target = String(p['data-target'] ?? '');
  return (
    <a className="wikilink-missing" href={`/new?title=${encodeURIComponent(target)}`} title={p['data-status'] === 'ambiguous' ? 'Ambiguous wikilink' : 'Create page'}>
      {p.children}
    </a>
  );
}

export interface MarkdownProps {
  src: string;
  path: string;
  ctx: VaultContext | null;
  onToggleTask?: (index: number, checked: boolean) => void;
}

export function Markdown({ src, path, ctx, onToggleTask }: MarkdownProps) {
  const navigate = useNavigate();
  const tree = useMemo(() => renderToHast(src, { path, ctx, pageHref }).hast, [src, path, ctx]);
  const taskIndex = { i: 0 };
  const element = toJsxRuntime(tree, {
    Fragment,
    jsx: jsx as never,
    jsxs: jsxs as never,
    passNode: false,
    components: {
      'n2-callout': Callout as never,
      'n2-drawer': DrawerButton as never,
      'n2-mermaid': ((p: P) => <Mermaid source={String(p['data-source'] ?? '')} title={String(p['data-title'] ?? '')} caption={String(p['data-caption'] ?? '')} />) as never,
      'n2-wikilink': Wikilink as never,
      img: Img as never,
      figure: Figure as never,
      table: Table as never,
      pre: Pre as never,
      input: ((p: P & { type?: string; checked?: boolean }) => {
        if (p.type !== 'checkbox') return <input {...(p as ComponentProps<'input'>)} />;
        const idx = taskIndex.i++;
        return <input type="checkbox" defaultChecked={!!p.checked} disabled={!onToggleTask} aria-label="Task" onChange={(e) => onToggleTask?.(idx, e.currentTarget.checked)} />;
      }) as never,
      a: ((p: P & { href?: string }) => {
        const page = p['data-page'] as string | undefined;
        const { node: _n, ...rest } = p;
        if (page)
          return (
            <a
              {...(rest as ComponentProps<'a'>)}
              onClick={(e) => {
                if (e.metaKey || e.ctrlKey || e.shiftKey || e.button !== 0) return;
                e.preventDefault();
                const hash = p.href?.split('#')[1];
                void navigate({ to: '/p/$', params: { _splat: page }, hash: hash ? decodeURIComponent(hash) : undefined });
              }}
            />
          );
        return <a {...(rest as ComponentProps<'a'>)} />;
      }) as never,
    },
  });
  return <div className="prose">{element}</div>;
}
