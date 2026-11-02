import { useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { useNavigate } from '@tanstack/react-router';
import { useTree } from '../api/hooks.ts';
import { api, qs } from '../api/client.ts';
import { cycleTheme } from '../lib/theme.ts';

interface Item {
  group: string;
  label: string;
  hint?: string;
  run: () => void;
}

function score(q: string, s: string): number {
  const a = q.toLowerCase();
  const b = s.toLowerCase();
  if (!a) return 1;
  if (b === a) return 100;
  if (b.startsWith(a)) return 50;
  if (b.includes(a)) return 20;
  let i = 0;
  for (const ch of b) if (ch === a[i]) i++;
  return i === a.length ? 5 : 0;
}

/** Cmd/Ctrl+K: instant page and alias matches from the cached tree, full-text from the server, actions. */
export function Palette({ onClose, currentPath }: { onClose: () => void; currentPath: string | null }) {
  const [q, setQ] = useState('');
  const [sel, setSel] = useState(0);
  const [remote, setRemote] = useState<{ path: string; title: string; snippet: string }[]>([]);
  const tree = useTree();
  const navigate = useNavigate();
  const input = useRef<HTMLInputElement>(null);
  const go = (path: string, hash?: string) => {
    void navigate({ to: '/p/$', params: { _splat: path }, ...(hash ? { hash } : {}) });
    onClose();
  };
  useEffect(() => input.current?.focus(), []);
  useEffect(() => {
    if (q.trim().length < 2) {
      setRemote([]);
      return;
    }
    const t = setTimeout(() => {
      void api<{ results: { path: string; title: string; snippet: string }[] }>(`/search${qs({ q, limit: 8 })}`).then((r) => setRemote(r.results)).catch(() => setRemote([]));
    }, 150);
    return () => clearTimeout(t);
  }, [q]);

  const items = useMemo<Item[]>(() => {
    const pages = (tree.data?.pages ?? [])
      .map((p) => ({ p, s: Math.max(score(q, p.title), ...p.aliases.map((a) => score(q, a) - 1), score(q, p.path) - 2) }))
      .filter((x) => x.s > 0)
      .sort((a, b) => b.s - a.s)
      .slice(0, 8)
      .map(({ p }) => ({ group: 'Pages', label: p.title, hint: p.path, run: () => go(p.path) }));
    const seen = new Set(pages.map((p) => p.hint));
    const text = remote.filter((r) => !seen.has(r.path)).map((r) => ({ group: 'Text', label: r.title, hint: r.snippet.replace(/<\/?mark>/g, ''), run: () => go(r.path) }));
    const dir = currentPath?.includes('/') ? currentPath.slice(0, currentPath.lastIndexOf('/')) : '';
    const actions: Item[] = [
      { group: 'Actions', label: 'New page here', hint: dir ? `/${dir}/` : '/', run: () => (void navigate({ to: '/new', search: { dir } }), onClose()) },
      { group: 'Actions', label: 'Open link explorer', run: () => (void navigate({ to: '/links', search: currentPath ? { page: currentPath } : {} }), onClose()) },
      { group: 'Actions', label: 'Export as standard markdown', run: () => (void navigate({ to: '/export', search: currentPath ? { path: currentPath } : {} }), onClose()) },
      { group: 'Actions', label: 'Activity', run: () => (void navigate({ to: '/activity' }), onClose()) },
      { group: 'Actions', label: 'Search everything', hint: q, run: () => (void navigate({ to: '/search', search: { q } }), onClose()) },
      { group: 'Actions', label: 'Toggle theme', run: () => (cycleTheme(), onClose()) },
      { group: 'Actions', label: 'Settings', run: () => (void navigate({ to: '/settings' }), onClose()) },
    ].filter((a) => !q || score(q, a.label) > 0 || a.label === 'Search everything');
    return [...pages, ...text, ...actions];
  }, [tree.data, q, remote, currentPath]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => setSel(0), [q]);
  return createPortal(
    <>
      <div className="scrim" onClick={onClose} />
      <div className="palette" role="dialog" aria-modal="true" aria-label="Command palette">
        <input
          ref={input}
          value={q}
          placeholder="Search pages, text, or actions"
          role="combobox"
          aria-expanded="true"
          aria-controls="palette-list"
          aria-activedescendant={`pi-${sel}`}
          onChange={(e) => setQ(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'ArrowDown') setSel((s) => Math.min(s + 1, items.length - 1));
            else if (e.key === 'ArrowUp') setSel((s) => Math.max(s - 1, 0));
            else if (e.key === 'Enter') items[sel]?.run();
            else if (e.key === 'Escape') onClose();
            else return;
            e.preventDefault();
          }}
        />
        <ul id="palette-list" role="listbox">
          {items.map((it, i) => (
            <li key={`${it.group}-${it.label}-${i}`} id={`pi-${i}`} role="option" aria-selected={i === sel} onMouseEnter={() => setSel(i)} onClick={it.run}>
              <span>{it.label}</span>
              {it.hint && <small>{it.hint}</small>}
            </li>
          ))}
          {items.length === 0 && <li className="group">No matches.</li>}
        </ul>
      </div>
    </>,
    document.body,
  );
}
