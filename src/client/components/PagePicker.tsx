// A searchable page dropdown: the tree in order, indented; typing filters by title.
import { useEffect, useId, useMemo, useRef, useState } from 'react';
import { buildTree, type TreeNode } from '@shared/tree';
import type { PageSummary } from '@shared/types';
import { Icon } from './Icon';

interface Option {
  id: string | null;
  label: string;
  icon: string | null;
  depth: number;
  hint?: string;
}

export function PagePicker(props: {
  pages: PageSummary[];
  value: string | null;
  onChange: (id: string | null) => void;
  /** Label for the "no page" option, shown first. */
  noneLabel: string;
  'aria-label'?: string;
}) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const [active, setActive] = useState(0);
  const root = useRef<HTMLDivElement>(null);
  const list = useRef<HTMLUListElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  const listId = useId();

  const ordered = useMemo(() => {
    const out: { page: PageSummary; depth: number; path: string[] }[] = [];
    const walk = (nodes: TreeNode[], depth: number, path: string[]) => {
      for (const n of nodes) {
        out.push({ page: n.page, depth, path });
        walk(n.children, depth + 1, [...path, n.page.title]);
      }
    };
    walk(buildTree(props.pages), 0, []);
    return out;
  }, [props.pages]);

  const options: Option[] = useMemo(() => {
    const q = query.trim().toLowerCase();
    const none: Option = { id: null, label: props.noneLabel, icon: null, depth: 0 };
    if (!q)
      return [
        none,
        ...ordered.map((o) => ({
          id: o.page.id,
          label: o.page.title,
          icon: o.page.icon,
          depth: o.depth,
        })),
      ];
    return ordered
      .filter((o) => o.page.title.toLowerCase().includes(q))
      .map((o) => ({
        id: o.page.id,
        label: o.page.title,
        icon: o.page.icon,
        depth: 0,
        hint: o.path.join(' › ') || undefined,
      }));
  }, [ordered, query, props.noneLabel]);

  const current = props.pages.find((p) => p.id === props.value);

  useEffect(() => {
    if (!open) return;
    const onDown = (e: PointerEvent) => {
      if (!root.current?.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener('pointerdown', onDown);
    return () => document.removeEventListener('pointerdown', onDown);
  }, [open]);

  useEffect(() => {
    if (!open) return;
    list.current
      ?.querySelector<HTMLElement>(`[data-index="${active}"]`)
      ?.scrollIntoView({ block: 'nearest' });
  }, [active, open]);

  function show() {
    setQuery('');
    const i = options.findIndex((o) => o.id === (props.value ?? null));
    setActive(Math.max(0, i));
    setOpen(true);
  }

  function choose(o: Option | undefined) {
    if (!o) return;
    setOpen(false);
    trigger.current?.focus();
    if (o.id !== (props.value ?? null)) props.onChange(o.id);
  }

  function onKey(e: React.KeyboardEvent) {
    if (e.key === 'ArrowDown') setActive((a) => Math.min(options.length - 1, a + 1));
    else if (e.key === 'ArrowUp') setActive((a) => Math.max(0, a - 1));
    else if (e.key === 'Enter') choose(options[active]);
    else if (e.key === 'Escape') {
      setOpen(false);
      trigger.current?.focus();
    } else return;
    e.preventDefault();
  }

  return (
    <div className="picker" ref={root}>
      <button
        ref={trigger}
        type="button"
        className="picker-trigger"
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-label={props['aria-label']}
        onClick={() => (open ? setOpen(false) : show())}
        onKeyDown={(e) => {
          if (!open && (e.key === 'ArrowDown' || e.key === 'ArrowUp')) {
            e.preventDefault();
            show();
          }
        }}
      >
        {current ? (
          <>
            {current.icon ? (
              <span className="picker-emoji">{current.icon}</span>
            ) : (
              <Icon name="page" size={15} />
            )}
            <span className="picker-value">{current.title}</span>
          </>
        ) : (
          <span className="picker-value muted">{props.noneLabel}</span>
        )}
        <span className="picker-chevron">
          <Icon name="chevron" size={14} />
        </span>
      </button>
      {open && (
        <div className="picker-pop">
          <div className="picker-search">
            <Icon name="search" size={14} />
            <input
              autoFocus
              value={query}
              placeholder="Find a page"
              role="combobox"
              aria-expanded
              aria-controls={listId}
              aria-activedescendant={`${listId}-${active}`}
              onChange={(e) => {
                setQuery(e.target.value);
                setActive(0);
              }}
              onKeyDown={onKey}
            />
          </div>
          <ul className="picker-list" role="listbox" id={listId} ref={list}>
            {options.length === 0 && <li className="picker-empty">No pages match.</li>}
            {options.map((o, i) => {
              const selected = o.id === (props.value ?? null);
              return (
                <li
                  key={o.id ?? ''}
                  id={`${listId}-${i}`}
                  data-index={i}
                  role="option"
                  aria-selected={selected}
                  className={i === active ? 'active' : undefined}
                  style={{ paddingLeft: 10 + o.depth * 16 }}
                  onPointerMove={() => setActive(i)}
                  onClick={() => choose(o)}
                >
                  {o.id === null ? (
                    <Icon name="home" size={15} />
                  ) : o.icon ? (
                    <span className="picker-emoji">{o.icon}</span>
                  ) : (
                    <Icon name="page" size={15} />
                  )}
                  <span className="picker-main">
                    <span className="picker-label">{o.label}</span>
                    {o.hint && <span className="picker-hint">{o.hint}</span>}
                  </span>
                  {selected && (
                    <span className="picker-check">
                      <Icon name="check" size={15} />
                    </span>
                  )}
                </li>
              );
            })}
          </ul>
        </div>
      )}
    </div>
  );
}
