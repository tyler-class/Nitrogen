import { lazy, Suspense, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Link, useNavigate, useParams, useSearchParams } from 'react-router';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { pageHref } from '@shared/markdown';
import type { Page, PageDetail, PageSummary, Revision, RevisionDetail } from '@shared/types';
import { api, ApiError, errorMessage } from '../lib/api';
import { keys, useCreatePage, useDeletePage, usePage, useTree } from '../lib/queries';
import { readLocal, writeLocal } from '../lib/storage';
import type { EditorHandle } from '../components/Editor';
import { EmojiButton } from '../components/EmojiPicker';
import { Icon, PageGlyph } from '../components/Icon';
import { Markdown, type TitleIndex } from '../components/Markdown';
import { Menu } from '../components/Tree';
import { useToast } from '../components/Toast';

// CodeMirror is most of the bundle; load it only when someone edits.
const Editor = lazy(() => import('../components/Editor').then((m) => ({ default: m.Editor })));

export function useTitleIndex(): { index: TitleIndex; titles: string[] } {
  const tree = useTree();
  return useMemo(() => {
    const index: TitleIndex = new Map();
    for (const p of tree.data?.pages ?? [])
      if (!index.has(p.title.toLowerCase())) index.set(p.title.toLowerCase(), p);
    return { index, titles: [...new Set((tree.data?.pages ?? []).map((p) => p.title))].sort() };
  }, [tree.data]);
}

export function PageView() {
  const { id } = useParams<{ id: string }>();
  const [params, setParams] = useSearchParams();
  const editing = params.get('edit') === '1';
  const q = usePage(id);
  const navigate = useNavigate();

  // Keep the slug in the URL in step with the title.
  const detail = q.data;
  useEffect(() => {
    if (!detail) return;
    const want = pageHref(detail.page.id, detail.page.title);
    if (window.location.pathname !== want)
      navigate(`${want}${window.location.search}${window.location.hash}`, { replace: true });
  }, [detail, navigate]);

  if (q.isPending) return <div className="page-loading" aria-busy="true" />;
  if (q.error)
    return (
      <div className="page-missing">
        <h1>
          {q.error instanceof ApiError && q.error.status === 404
            ? 'Page not found'
            : 'Could not load this page'}
        </h1>
        <p>
          {q.error instanceof ApiError && q.error.status === 404
            ? 'It may have been deleted or moved.'
            : errorMessage(q.error)}
        </p>
        <Link to="/">Go home</Link>
      </div>
    );

  const setEditing = (on: boolean) => {
    const next = new URLSearchParams(params);
    if (on) next.set('edit', '1');
    else next.delete('edit');
    setParams(next, { replace: true });
  };

  return editing ? (
    <EditPage key={detail!.page.id} detail={detail!} onDone={() => setEditing(false)} />
  ) : (
    <ReadPage detail={detail!} onEdit={() => setEditing(true)} />
  );
}

function Breadcrumbs({ ancestors, page }: { ancestors: PageSummary[]; page: { title: string } }) {
  return (
    <nav className="crumbs" aria-label="Breadcrumb">
      <Link to="/">
        <Icon name="home" size={14} label="Home" />
      </Link>
      {ancestors.map((a) => (
        <span key={a.id}>
          <Icon name="chevron" size={11} />
          <Link to={pageHref(a.id, a.title)}>{a.title}</Link>
        </span>
      ))}
      <span>
        <Icon name="chevron" size={11} />
        <span aria-current="page">{page.title}</span>
      </span>
    </nav>
  );
}

function ReadPage({ detail, onEdit }: { detail: PageDetail; onEdit(): void }) {
  const { page, ancestors, children, backlinks } = detail;
  const { index } = useTitleIndex();
  const [menu, setMenu] = useState(false);
  const [history, setHistory] = useState(false);
  const create = useCreatePage();
  const del = useDeletePage();
  const tree = useTree();
  const qc = useQueryClient();
  const navigate = useNavigate();
  const toast = useToast();

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement;
      if (
        e.key === 'e' &&
        !e.metaKey &&
        !e.ctrlKey &&
        !t.closest('input, textarea, [contenteditable]')
      ) {
        e.preventDefault();
        onEdit();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onEdit]);

  // Scroll to #h-… anchors after the body renders.
  useEffect(() => {
    if (location.hash)
      document.getElementById(decodeURIComponent(location.hash.slice(1)))?.scrollIntoView();
  }, [page.id, page.body]);

  async function addChild() {
    try {
      const p = await create.mutateAsync({ title: 'Untitled', parent_id: page.id });
      navigate(`${pageHref(p.id, p.title)}?edit=1`);
    } catch (e) {
      toast(errorMessage(e));
    }
  }

  async function setHome() {
    setMenu(false);
    await api.patch('/settings', { home_id: page.id }).catch((e) => toast(errorMessage(e)));
    await qc.invalidateQueries({ queryKey: keys.tree });
    toast('This is now your home page.');
  }

  async function remove() {
    setMenu(false);
    const n = (tree.data?.pages ?? []).filter((p) => p.parent_id === page.id).length;
    if (
      !window.confirm(
        n
          ? `Delete “${page.title}” and everything inside it? This can’t be undone.`
          : `Delete “${page.title}”? This can’t be undone.`,
      )
    )
      return;
    try {
      await del.mutateAsync(page.id);
      const parent = ancestors[ancestors.length - 1];
      navigate(parent ? pageHref(parent.id, parent.title) : '/', { replace: true });
    } catch (e) {
      toast(errorMessage(e));
    }
  }

  return (
    <article className="page">
      <div className="page-top">
        <Breadcrumbs ancestors={ancestors} page={page} />
        <div className="page-actions">
          <button className="btn" onClick={onEdit} title="Edit (E)">
            <Icon name="edit" size={15} /> Edit
          </button>
          <button
            className="btn icon-only"
            onClick={() => setHistory(true)}
            aria-label="History"
            title="History"
          >
            <Icon name="history" size={15} />
          </button>
          <div className="menu-anchor">
            <button
              className="btn icon-only"
              onClick={() => setMenu((m) => !m)}
              aria-label="More"
              aria-haspopup="menu"
              aria-expanded={menu}
            >
              <Icon name="more" size={15} />
            </button>
            {menu && (
              <Menu onClose={() => setMenu(false)}>
                <button role="menuitem" onClick={() => (setMenu(false), void addChild())}>
                  Add subpage
                </button>
                <button role="menuitem" onClick={setHome}>
                  Set as home page
                </button>
                <button
                  role="menuitem"
                  onClick={() => {
                    setMenu(false);
                    void navigator.clipboard?.writeText(`[[${page.title}]]`);
                    toast('Link copied. Paste it into another page.');
                  }}
                >
                  Copy wiki link
                </button>
                <button role="menuitem" className="danger" onClick={remove}>
                  Delete
                </button>
              </Menu>
            )}
          </div>
        </div>
      </div>
      <header className="page-head">
        {page.icon && <div className="page-icon">{page.icon}</div>}
        <h1 className="page-title">{page.title}</h1>
        <p className="page-meta">Updated {formatWhen(page.updated_at)}</p>
      </header>
      <div className="prose">
        {page.body.trim() ? (
          <Markdown source={page.body} titles={index} />
        ) : (
          <button className="empty-body" onClick={onEdit}>
            This page is empty. Click to start writing.
          </button>
        )}
      </div>

      <section className="related" aria-label="Pages inside">
        <div className="related-head">
          <h2>Pages inside</h2>
          <button className="btn small" onClick={addChild}>
            <Icon name="plus" size={14} /> Add subpage
          </button>
        </div>
        {children.length ? (
          <div className="cards">
            {children.map((c) => (
              <Link key={c.id} to={pageHref(c.id, c.title)} className="card">
                <PageGlyph icon={c.icon} folder={false} />
                <span>{c.title}</span>
              </Link>
            ))}
          </div>
        ) : (
          <p className="muted">None yet.</p>
        )}
      </section>

      {backlinks.length > 0 && (
        <section className="related" aria-label="Linked from">
          <div className="related-head">
            <h2>Linked from</h2>
          </div>
          <ul className="backlinks">
            {backlinks.map((b) => (
              <li key={b.id}>
                <Link to={pageHref(b.id, b.title)}>
                  <PageGlyph icon={b.icon} folder={false} /> {b.title}
                </Link>
              </li>
            ))}
          </ul>
        </section>
      )}
      {history && <HistoryPanel page={page} onClose={() => setHistory(false)} />}
    </article>
  );
}

type SaveState = 'saved' | 'dirty' | 'saving' | 'error' | 'conflict';
interface Draft {
  title: string;
  icon: string;
  body: string;
  base: number;
}

function EditPage({ detail, onDone }: { detail: PageDetail; onDone(): void }) {
  const { page, ancestors } = detail;
  const qc = useQueryClient();
  const toast = useToast();
  const { titles } = useTitleIndex();
  const editor = useRef<EditorHandle>(null);
  const draftKey = `n2.draft.${page.id}`;
  const [draft, setDraft] = useState<Draft>({
    title: page.title,
    icon: page.icon ?? '',
    body: page.body,
    base: page.version,
  });
  const [state, setState] = useState<SaveState>('saved');
  const [editorKey, setEditorKey] = useState(0);
  const [stale] = useState<Draft | null>(() => {
    const d = readLocal<Draft | null>(draftKey, null);
    return d && (d.body !== page.body || d.title !== page.title) ? d : null;
  });
  const [offerDraft, setOfferDraft] = useState(!!stale);
  // The latest draft for async saves; kept in step by change(), save() and loadLatest().
  const current = useRef(draft);
  const saving = useRef<Promise<void> | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout>>(undefined);

  const save = useCallback(
    async (force = false): Promise<void> => {
      clearTimeout(timer.current);
      if (saving.current) {
        await saving.current;
      }
      const d = current.current;
      const cached = qc.getQueryData<PageDetail>(keys.page(page.id))?.page;
      if (
        cached &&
        d.body === cached.body &&
        d.title === cached.title &&
        (d.icon || null) === cached.icon &&
        d.base === cached.version
      ) {
        setState('saved');
        return;
      }
      if (!d.title.trim()) return setState('dirty');
      setState('saving');
      const run = (async () => {
        try {
          const next = await api.patch<Page>(`/pages/${page.id}`, {
            title: d.title.trim(),
            icon: d.icon.trim() || null,
            body: d.body,
            ...(force ? {} : { base_version: d.base }),
          });
          setDraft((cur) => ({ ...cur, base: next.version }));
          current.current = { ...current.current, base: next.version };
          qc.setQueryData<PageDetail>(keys.page(page.id), (old) =>
            old ? { ...old, page: next } : old,
          );
          if (!cached || cached.title !== next.title || cached.icon !== next.icon)
            void qc.invalidateQueries({ queryKey: keys.tree });
          const latest = current.current;
          if (latest.body === d.body && latest.title === d.title && latest.icon === d.icon) {
            writeLocal(draftKey, undefined);
            setState('saved');
          } else setState('dirty');
        } catch (e) {
          if (e instanceof ApiError && e.status === 409) setState('conflict');
          else {
            setState('error');
            toast(errorMessage(e));
          }
        }
      })();
      saving.current = run;
      await run;
      saving.current = null;
    },
    [page.id, qc, toast, draftKey],
  );

  const change = (patch: Partial<Draft>) => {
    setDraft((d) => {
      const next = { ...d, ...patch };
      current.current = next;
      writeLocal(draftKey, next);
      return next;
    });
    if (state !== 'conflict') {
      setState('dirty');
      clearTimeout(timer.current);
      timer.current = setTimeout(() => void save(), 1200);
    }
  };

  // Save before leaving the page or closing the tab.
  useEffect(() => {
    const before = (e: BeforeUnloadEvent) => {
      if (state !== 'saved') {
        void save();
        e.preventDefault();
      }
    };
    window.addEventListener('beforeunload', before);
    return () => window.removeEventListener('beforeunload', before);
  }, [state, save]);
  useEffect(() => () => clearTimeout(timer.current), []);

  async function done() {
    if (state === 'conflict') return;
    await save();
    onDone();
  }

  async function loadLatest() {
    await navigator.clipboard?.writeText(current.current.body).catch(() => undefined);
    const fresh = await qc.fetchQuery({
      queryKey: keys.page(page.id),
      queryFn: () => api.get<PageDetail>(`/pages/${page.id}`),
      staleTime: 0,
    });
    const d = {
      title: fresh.page.title,
      icon: fresh.page.icon ?? '',
      body: fresh.page.body,
      base: fresh.page.version,
    };
    setDraft(d);
    current.current = d;
    setEditorKey((k) => k + 1);
    setState('saved');
    toast('Loaded the latest version. Your text was copied to the clipboard.');
  }

  const status: Record<SaveState, string> = {
    saved: 'Saved',
    dirty: 'Unsaved',
    saving: 'Saving…',
    error: 'Not saved',
    conflict: 'Changed elsewhere',
  };

  return (
    <article className="page editing">
      <div className="page-top">
        <Breadcrumbs ancestors={ancestors} page={{ title: draft.title || 'Untitled' }} />
        <div className="page-actions">
          <span className={`save-state ${state}`} aria-live="polite">
            {status[state]}
          </span>
          <button className="btn primary" onClick={done} disabled={state === 'conflict'}>
            <Icon name="check" size={15} /> Done
          </button>
        </div>
      </div>

      {state === 'conflict' && (
        <div className="banner warn" role="alert">
          <p>Someone (or an assistant) changed this page while you were editing.</p>
          <div>
            <button className="btn small" onClick={loadLatest}>
              Load latest (copies your text)
            </button>
            <button className="btn small" onClick={() => void save(true)}>
              Keep mine
            </button>
          </div>
        </div>
      )}
      {offerDraft && stale && (
        <div className="banner" role="status">
          <p>You have unsaved changes from an earlier session.</p>
          <div>
            <button
              className="btn small"
              onClick={() => {
                change({ title: stale.title, icon: stale.icon, body: stale.body });
                setEditorKey((k) => k + 1);
                setOfferDraft(false);
              }}
            >
              Restore them
            </button>
            <button
              className="btn small"
              onClick={() => {
                writeLocal(draftKey, undefined);
                setOfferDraft(false);
              }}
            >
              Discard
            </button>
          </div>
        </div>
      )}

      <header className="page-head">
        <div className="title-row">
          <EmojiButton value={draft.icon} onChange={(icon) => change({ icon })} />
          <input
            className="title-input"
            value={draft.title}
            onChange={(e) => change({ title: e.target.value })}
            placeholder="Untitled"
            aria-label="Title"
            autoFocus={page.title === 'Untitled'}
            onFocus={(e) => page.title === 'Untitled' && e.target.select()}
            onKeyDown={(e) => {
              if (e.key === 'Enter') {
                e.preventDefault();
                editor.current?.focus();
              }
            }}
          />
        </div>
      </header>

      <div className="toolbar" role="toolbar" aria-label="Formatting">
        <button onClick={() => editor.current?.wrap('**')} title="Bold (⌘B)" aria-label="Bold">
          <b>B</b>
        </button>
        <button onClick={() => editor.current?.wrap('_')} title="Italic (⌘I)" aria-label="Italic">
          <i>I</i>
        </button>
        <button
          onClick={() => editor.current?.wrap('\n## ', '\n')}
          title="Heading"
          aria-label="Heading"
        >
          H
        </button>
        <button
          onClick={() => editor.current?.wrap('[', '](https://)')}
          title="Link (⌘K)"
          aria-label="Link"
        >
          <Icon name="link" size={15} />
        </button>
        <button
          onClick={() => editor.current?.wrap('[[', ']]')}
          title="Link to a page"
          aria-label="Link to a page"
        >
          [[ ]]
        </button>
        <button
          onClick={() => editor.current?.wrap('\n> [!NOTE]\n> ', '\n')}
          title="Callout"
          aria-label="Callout"
        >
          <Icon name="panel" size={15} />
        </button>
        <button
          onClick={() => editor.current?.wrap('\n- [ ] ', '')}
          title="Checklist"
          aria-label="Checklist"
        >
          <Icon name="check" size={15} />
        </button>
        <button
          onClick={() => editor.current?.pickImages()}
          title="Insert image"
          aria-label="Insert image"
        >
          <Icon name="image" size={15} /> Image
        </button>
      </div>

      <Suspense fallback={<div className="editor" aria-busy="true" />}>
        <Editor
          key={editorKey}
          ref={editor}
          value={draft.body}
          pageId={page.id}
          titles={titles}
          onChange={(body) => change({ body })}
          onSave={() => void save()}
          onError={toast}
        />
      </Suspense>
    </article>
  );
}

function HistoryPanel({ page, onClose }: { page: Page; onClose(): void }) {
  const list = useQuery({
    queryKey: keys.revisions(page.id),
    queryFn: () => api.get<{ revisions: Revision[] }>(`/pages/${page.id}/revisions`),
  });
  const [sel, setSel] = useState<number | null>(null);
  const rev = useQuery({
    queryKey: ['revision', page.id, sel],
    queryFn: () => api.get<RevisionDetail>(`/pages/${page.id}/revisions/${sel}`),
    enabled: sel !== null,
  });
  const { index } = useTitleIndex();
  const qc = useQueryClient();
  const toast = useToast();

  async function restore() {
    if (sel === null) return;
    try {
      await api.post(`/pages/${page.id}/revisions/${sel}/restore`);
      await qc.invalidateQueries({ queryKey: keys.page(page.id) });
      await qc.invalidateQueries({ queryKey: keys.revisions(page.id) });
      void qc.invalidateQueries({ queryKey: keys.tree });
      toast('Restored. The version you replaced is in the history too.');
      onClose();
    } catch (e) {
      toast(errorMessage(e));
    }
  }

  return (
    <div className="scrim" onMouseDown={onClose}>
      <div
        className="drawer"
        role="dialog"
        aria-label="Page history"
        onMouseDown={(e) => e.stopPropagation()}
      >
        <div className="drawer-head">
          <h2>History</h2>
          <button className="btn icon-only" onClick={onClose} aria-label="Close">
            <Icon name="close" />
          </button>
        </div>
        <div className="history">
          <ul className="history-list">
            <li>
              <button className={sel === null ? 'current' : ''} onClick={() => setSel(null)}>
                <strong>Current</strong>
                <span>
                  version {page.version} · {formatWhen(page.updated_at)}
                </span>
              </button>
            </li>
            {list.data?.revisions.map((r) => (
              <li key={r.id}>
                <button className={sel === r.id ? 'current' : ''} onClick={() => setSel(r.id)}>
                  <strong>{formatWhen(r.created_at)}</strong>
                  <span>
                    version {r.version}
                    {r.title !== page.title ? ` · “${r.title}”` : ''}
                  </span>
                </button>
              </li>
            ))}
            {list.data && !list.data.revisions.length && (
              <li className="muted">No earlier versions yet.</li>
            )}
          </ul>
          <div className="history-preview prose">
            {sel === null ? (
              <Markdown source={page.body} titles={index} />
            ) : rev.data ? (
              <>
                <button className="btn primary small" onClick={restore}>
                  Restore this version
                </button>
                <h1>{rev.data.title}</h1>
                <Markdown source={rev.data.body} titles={index} />
              </>
            ) : (
              <p className="muted">Loading…</p>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}

export function formatWhen(iso: string): string {
  const d = new Date(iso);
  const diff = (Date.now() - d.getTime()) / 1000;
  if (diff < 60) return 'just now';
  if (diff < 3600) return `${Math.floor(diff / 60)} min ago`;
  if (diff < 86400) return `${Math.floor(diff / 3600)} h ago`;
  return d.toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' });
}
