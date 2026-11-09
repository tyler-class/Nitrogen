// ⌘K: jump to a page by title instantly, keyword matches as you type, Enter for a full
// (semantic + keyword) search.
import { useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate } from 'react-router';
import { pageHref } from '@shared/markdown';
import { ancestorsOf } from '@shared/tree';
import type { PageSummary, SearchResponse } from '@shared/types';
import { api } from '../lib/api';
import { Icon, PageGlyph } from './Icon';
import { Snippet } from './Snippet';

interface Item {
  key: string;
  label: string;
  hint?: string;
  snippet?: string;
  icon?: string | null;
  go(): void;
}

export function Palette({ pages, onClose }: { pages: PageSummary[]; onClose(): void }) {
  const [q, setQ] = useState('');
  const [sel, setSel] = useState(0);
  const [kw, setKw] = useState<SearchResponse | null>(null);
  const navigate = useNavigate();
  const byId = useMemo(() => new Map(pages.map((p) => [p.id, p])), [pages]);
  const list = useRef<HTMLUListElement>(null);

  useEffect(() => {
    const term = q.trim();
    if (term.length < 2) return;
    const ctl = new AbortController();
    const t = setTimeout(() => {
      api
        .get<SearchResponse>(
          `/search?${new URLSearchParams({ q: term, mode: 'keyword', limit: '8' })}`,
        )
        .then((r) => !ctl.signal.aborted && setKw(r))
        .catch(() => undefined);
    }, 120);
    return () => {
      clearTimeout(t);
      ctl.abort();
    };
  }, [q]);

  const items = useMemo<Item[]>(() => {
    const term = q.trim().toLowerCase();
    const go = (id: string) => () => {
      const p = byId.get(id);
      navigate(pageHref(id, p?.title));
      onClose();
    };
    const pathOf = (id: string) =>
      ancestorsOf(id, byId)
        .map((a) => a.title)
        .join(' / ');
    const titleHits = (
      term
        ? pages.filter((p) => p.title.toLowerCase().includes(term))
        : [...pages].sort((a, b) => b.updated_at.localeCompare(a.updated_at))
    )
      .sort(
        (a, b) =>
          Number(b.title.toLowerCase().startsWith(term)) -
          Number(a.title.toLowerCase().startsWith(term)),
      )
      .slice(0, 8);
    const out: Item[] = titleHits.map((p) => ({
      key: `t-${p.id}`,
      label: p.title,
      hint: pathOf(p.id),
      icon: p.icon,
      go: go(p.id),
    }));
    const seen = new Set(titleHits.map((p) => p.id));
    // Keyword hits only count while they match what's typed now.
    const live = term.length >= 2 && kw?.query.toLowerCase() === term ? kw.hits : [];
    for (const h of live) {
      if (seen.has(h.id)) continue;
      out.push({
        key: `k-${h.id}`,
        label: h.title,
        hint: h.path.join(' / '),
        snippet: h.snippet,
        icon: h.icon,
        go: go(h.id),
      });
    }
    if (term)
      out.push({
        key: 'semantic',
        label: `Search everything for “${q.trim()}”`,
        hint: 'By meaning and keywords',
        go: () => {
          navigate(`/search?q=${encodeURIComponent(q.trim())}`);
          onClose();
        },
      });
    return out;
  }, [q, kw, pages, byId, navigate, onClose]);

  useEffect(() => {
    list.current?.querySelector('[aria-selected="true"]')?.scrollIntoView({ block: 'nearest' });
  }, [sel]);

  return (
    <div className="scrim" onMouseDown={onClose}>
      <div
        className="palette"
        role="dialog"
        aria-label="Search"
        onMouseDown={(e) => e.stopPropagation()}
      >
        <div className="palette-input">
          <Icon name="search" />
          <input
            autoFocus
            value={q}
            placeholder="Search pages…"
            onChange={(e) => {
              setQ(e.target.value);
              setSel(0);
            }}
            onKeyDown={(e) => {
              if (e.key === 'Escape') onClose();
              else if (e.key === 'ArrowDown') {
                e.preventDefault();
                setSel((s) => Math.min(s + 1, items.length - 1));
              } else if (e.key === 'ArrowUp') {
                e.preventDefault();
                setSel((s) => Math.max(s - 1, 0));
              } else if (e.key === 'Enter') items[sel]?.go();
            }}
            role="combobox"
            aria-expanded="true"
            aria-controls="palette-list"
          />
          {/* Keyboards get the esc hint; phones get a close button (or tap outside). */}
          <kbd className="palette-esc">esc</kbd>
          <button
            type="button"
            className="palette-close"
            onClick={onClose}
            aria-label="Close search"
          >
            <Icon name="close" size={18} />
          </button>
        </div>
        <ul id="palette-list" ref={list} role="listbox" className="palette-list">
          {items.map((it, i) => (
            <li
              key={it.key}
              role="option"
              aria-selected={i === sel}
              onMouseMove={() => setSel(i)}
              onClick={it.go}
            >
              {it.key === 'semantic' ? (
                <span className="glyph">
                  <Icon name="sparkle" size={15} />
                </span>
              ) : (
                <PageGlyph icon={it.icon ?? null} folder={false} />
              )}
              <span className="palette-main">
                <span className="palette-label">{it.label}</span>
                {it.snippet ? (
                  <Snippet text={it.snippet} />
                ) : (
                  it.hint && <span className="palette-hint">{it.hint}</span>
                )}
              </span>
            </li>
          ))}
          {!items.length && <li className="palette-empty">No pages yet.</li>}
        </ul>
      </div>
    </div>
  );
}
