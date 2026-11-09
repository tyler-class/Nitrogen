import { lazy, Suspense, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Link, Navigate, useNavigate, useParams, useSearchParams } from 'react-router';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { actorLabel } from '@shared/actor';
import { ancestorsOf } from '@shared/tree';
import { ITEM_TYPES, extractItems, todayKey } from '@shared/items';
import { extractTags, pageHref, plainText } from '@shared/markdown';
import type {
  Mention,
  Page,
  PageDetail,
  PageSummary,
  RelatedPage,
  Revision,
  RevisionDetail,
} from '@shared/types';
import { api, ApiError, errorMessage } from '../lib/api';
import { keys, useCreatePage, useDeletePage, usePage, useTree } from '../lib/queries';
import { readLocal, writeLocal } from '../lib/storage';
import type { EditorHandle, LinkTarget } from '../components/Editor';
import { EmojiButton } from '../components/EmojiPicker';
import { Icon, PageGlyph } from '../components/Icon';
import { formatDue, Markdown, type TitleIndex } from '../components/Markdown';
import { DiffView } from '../components/Diff';
import { downloadPage } from '../lib/exportMarkdown';
import { TagEditor, TagList } from '../components/Tags';
import { Menu } from '../components/Tree';
import { useToast } from '../components/Toast';

// CodeMirror is most of the bundle; load it only when someone edits.
const Editor = lazy(() => import('../components/Editor').then((m) => ({ default: m.Editor })));

/** Pages to offer after "[[" (not AI Sessions), most recently edited first, with their place in the tree. */
function useLinkTargets(): LinkTarget[] {
  const tree = useTree();
  return useMemo(() => {
    const pages = tree.data?.pages ?? [];
    const sid = tree.data?.sessions_id;
    const byId = new Map(pages.map((p) => [p.id, p]));
    return pages
      .filter((p) => !sid || (p.id !== sid && p.parent_id !== sid))
      .sort((a, b) => b.updated_at.localeCompare(a.updated_at))
      .map((p) => ({
        title: p.title,
        icon: p.icon,
        path: ancestorsOf(p.id, byId).map((a) => a.title),
      }));
  }, [tree.data]);
}

export function useTitleIndex(): { index: TitleIndex; titles: string[] } {
  const tree = useTree();
  return useMemo(() => {
    const index: TitleIndex = new Map();
    for (const p of tree.data?.pages ?? [])
      if (!index.has(p.title.toLowerCase())) index.set(p.title.toLowerCase(), p);
    return { index, titles: [...new Set((tree.data?.pages ?? []).map((p) => p.title))].sort() };
  }, [tree.data]);
}

/**
 * A wiki page. `pageId` and `header` let another view show a page in its own frame (the
 * Conventions view): `header` replaces the breadcrumbs, and the URL stays where it is.
 */
export function PageView({ pageId, header }: { pageId?: string; header?: React.ReactNode } = {}) {
  const params0 = useParams<{ id: string }>();
  const id = pageId ?? params0.id;
  const [params, setParams] = useSearchParams();
  const editing = params.get('edit') === '1';
  const q = usePage(id);
  const tree = useTree();
  const navigate = useNavigate();

  // Keep the slug in the URL in step with the title.
  const detail = q.data;
  useEffect(() => {
    if (!detail || pageId) return;
    if (detail.page.id === tree.data?.conventions_id) return;
    const sid = tree.data?.sessions_id;
    if (sid && (detail.page.id === sid || detail.page.parent_id === sid)) return;
    const want = pageHref(detail.page.id, detail.page.title);
    if (window.location.pathname !== want)
      navigate(`${want}${window.location.search}${window.location.hash}`, { replace: true });
  }, [detail, navigate, tree.data, pageId]);

  // Sessions and Conventions have their own views, outside the wiki.
  if (!pageId && detail && detail.page.id === tree.data?.conventions_id)
    return <Navigate to={`/conventions${window.location.search}`} replace />;
  const sessionsId = tree.data?.sessions_id;
  if (sessionsId && detail) {
    if (detail.page.id === sessionsId) return <Navigate to="/sessions" replace />;
    if (detail.page.parent_id === sessionsId)
      return <Navigate to={`/sessions/${detail.page.id}`} replace />;
  }
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
    <ReadPage detail={detail!} onEdit={() => setEditing(true)} header={header} />
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

function ReadPage({
  detail,
  onEdit,
  header,
}: {
  detail: PageDetail;
  onEdit(): void;
  header?: React.ReactNode;
}) {
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
  // Sessions and its entries are written by the system only.
  const sessionsId = tree.data?.sessions_id ?? null;
  const locked: 'root' | 'entry' | null = !sessionsId
    ? null
    : page.id === sessionsId
      ? 'root'
      : ancestors.some((a) => a.id === sessionsId)
        ? 'entry'
        : null;

  const toggleItem = useCallback(
    async (line: number, done: boolean) => {
      try {
        const next = await api.post<Page>(`/pages/${page.id}/items/toggle`, { line, done });
        qc.setQueryData<PageDetail>(keys.page(page.id), (old) =>
          old ? { ...old, page: next } : old,
        );
        void qc.invalidateQueries({ queryKey: ['items'] });
      } catch (e) {
        toast(errorMessage(e));
      }
    },
    [page.id, qc, toast],
  );

  const answerItem = useCallback(
    async (line: number, answer: string) => {
      try {
        const next = await api.post<Page>(`/pages/${page.id}/items/answer`, { line, answer });
        qc.setQueryData<PageDetail>(keys.page(page.id), (old) =>
          old ? { ...old, page: next } : old,
        );
        void qc.invalidateQueries({ queryKey: ['items'] });
      } catch (e) {
        toast(errorMessage(e));
      }
    },
    [page.id, qc, toast],
  );

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement;
      if (
        !locked &&
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
  }, [onEdit, locked]);

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

  async function pin() {
    setMenu(false);
    try {
      await api.post(`/pages/${page.id}/pin`, { pinned: !page.pinned_at });
      await qc.invalidateQueries({ queryKey: keys.page(page.id) });
      void qc.invalidateQueries({ queryKey: ['dashboard'] });
      toast(page.pinned_at ? 'Unpinned.' : 'Pinned to the dashboard.');
    } catch (e) {
      toast(errorMessage(e));
    }
  }

  async function purge() {
    setMenu(false);
    if (!window.confirm(`Purge “${page.title}”? The entry is removed for good.`)) return;
    try {
      await api.del(`/sessions/${page.id}`);
      qc.removeQueries({ queryKey: keys.page(page.id) });
      void qc.invalidateQueries({ queryKey: keys.tree });
      const parent = ancestors[ancestors.length - 1];
      navigate(parent ? pageHref(parent.id, parent.title) : '/', { replace: true });
    } catch (e) {
      toast(errorMessage(e));
    }
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
        {header ?? <Breadcrumbs ancestors={ancestors} page={page} />}
        <div className="page-actions">
          {!locked && (
            <button className="btn" onClick={onEdit} title="Edit (E)">
              <Icon name="edit" size={15} /> Edit
            </button>
          )}
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
                {!locked && !header && (
                  <button role="menuitem" onClick={() => (setMenu(false), void addChild())}>
                    Add subpage
                  </button>
                )}
                <button role="menuitem" onClick={pin}>
                  {page.pinned_at ? 'Unpin from dashboard' : 'Pin to dashboard'}
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
                <button
                  role="menuitem"
                  onClick={() => {
                    setMenu(false);
                    void navigator.clipboard?.writeText(
                      `Use the Nitrogen review_page prompt on “${page.title}” (id ${page.id}): check it against newer pages and list anything stale or contradicted.`,
                    );
                    toast('Copied. Paste it into Claude to check this page.');
                  }}
                >
                  Copy review request
                </button>
                <button
                  role="menuitem"
                  onClick={() => {
                    setMenu(false);
                    downloadPage(page);
                  }}
                >
                  Download as Markdown
                </button>
                {!locked && (
                  <button role="menuitem" className="danger" onClick={remove}>
                    Delete
                  </button>
                )}
                {locked === 'entry' && (
                  <button role="menuitem" className="danger" onClick={purge}>
                    Purge entry
                  </button>
                )}
              </Menu>
            )}
          </div>
        </div>
      </div>
      <header className="page-head">
        {page.icon && <div className="page-icon">{page.icon}</div>}
        <h1 className="page-title">{page.title}</h1>
        <p className="page-meta">
          Updated {formatWhen(page.updated_at)}
          {page.updated_by && ` by ${actorLabel(page.updated_by)}`}
          {page.created_by && page.created_by !== page.updated_by
            ? ` · created by ${actorLabel(page.created_by)}`
            : ''}
        </p>
        <TagList tags={detail.all_tags} />
      </header>
      {locked && (
        <p className="locked-note">
          <Icon name="lock" size={14} />{' '}
          {locked === 'root'
            ? 'Assistants record their sessions here automatically. Read-only.'
            : 'Recorded automatically from what the assistant did. Read-only.'}
        </p>
      )}
      <ItemSummary body={page.body} />
      <div className="prose">
        {page.body.trim() ? (
          <Markdown
            source={page.body}
            titles={index}
            onToggleItem={locked ? undefined : toggleItem}
            onAnswerItem={locked ? undefined : answerItem}
          />
        ) : locked ? null : (
          <button className="empty-body" onClick={onEdit}>
            This page is empty. Click to start writing.
          </button>
        )}
      </div>

      {locked !== 'entry' && (!header || children.length > 0) && (
        <section className="related" aria-label="Pages inside">
          <div className="related-head">
            <h2>{locked === 'root' ? 'Sessions' : 'Pages inside'}</h2>
            {!locked && (
              <button className="btn small" onClick={addChild}>
                <Icon name="plus" size={14} /> Add subpage
              </button>
            )}
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
      )}

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
      <Mentions page={page} />
      <Related page={page} />
      {history && <HistoryPanel page={page} onClose={() => setHistory(false)} />}
    </article>
  );
}

type SaveState = 'saved' | 'dirty' | 'saving' | 'error' | 'conflict';
interface Draft {
  title: string;
  icon: string;
  body: string;
  tags: string[];
  base: number;
}

const sameTags = (a: string[] | undefined, b: string[] | undefined) =>
  JSON.stringify(a ?? []) === JSON.stringify(b ?? []);

function EditPage({ detail, onDone }: { detail: PageDetail; onDone(): void }) {
  const { page, ancestors } = detail;
  const qc = useQueryClient();
  const toast = useToast();
  const links = useLinkTargets();
  const editor = useRef<EditorHandle>(null);
  const draftKey = `n2.draft.${page.id}`;
  const [draft, setDraft] = useState<Draft>({
    title: page.title,
    icon: page.icon ?? '',
    body: page.body,
    tags: page.tags,
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
        sameTags(d.tags, cached.tags) &&
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
            tags: d.tags,
            ...(force ? {} : { base_version: d.base }),
          });
          setDraft((cur) => ({ ...cur, base: next.version }));
          current.current = { ...current.current, base: next.version };
          qc.setQueryData<PageDetail>(keys.page(page.id), (old) =>
            old ? { ...old, page: next } : old,
          );
          if (!cached || cached.title !== next.title || cached.icon !== next.icon)
            void qc.invalidateQueries({ queryKey: keys.tree });
          // all_tags (incl. #tags in the body) comes from the server; refresh it when viewing.
          if (!cached || !sameTags(cached.tags, next.tags) || cached.body !== next.body)
            void qc.invalidateQueries({ queryKey: keys.page(page.id), refetchType: 'none' });
          const latest = current.current;
          if (
            latest.body === d.body &&
            latest.title === d.title &&
            latest.icon === d.icon &&
            sameTags(latest.tags, d.tags)
          ) {
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
      tags: fresh.page.tags,
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
                change({
                  title: stale.title,
                  icon: stale.icon,
                  body: stale.body,
                  tags: stale.tags ?? draft.tags,
                });
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
        <TagEditor
          tags={draft.tags}
          bodyTags={extractTags(draft.body)}
          onChange={(tags) => change({ tags })}
        />
      </header>

      <div className="toolbar" role="toolbar" aria-label="Formatting">
        <button onClick={() => editor.current?.wrap('**')} title="Bold (⌘B)" aria-label="Bold">
          <b>B</b>
        </button>
        <button onClick={() => editor.current?.wrap('_')} title="Italic (⌘I)" aria-label="Italic">
          <i>I</i>
        </button>
        {([1, 2, 3] as const).map((n) => (
          <button
            key={n}
            onClick={() => editor.current?.heading(n)}
            title={`Heading ${n} (${'#'.repeat(n)})`}
            aria-label={`Heading ${n}`}
            className="tb-h"
          >
            H<sub>{n}</sub>
          </button>
        ))}
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
          onClick={() =>
            editor.current?.wrap(
              '\n```mermaid\nflowchart LR\n  A[Start] --> B{Decision}\n  B -->|Yes| C[Do it]\n  B -->|No| D[Skip]\n',
              '```\n',
            )
          }
          title="Mermaid diagram (rendered when you’re done editing)"
          aria-label="Insert a diagram"
        >
          <Icon name="graph" size={15} /> Diagram
        </button>
        <span className="toolbar-sep" aria-hidden />
        <button
          onClick={() => editor.current?.wrap('\n- [ ] todo: ', '')}
          title="To do: - [ ] todo: … @owner due:YYYY-MM-DD"
          aria-label="Insert a to-do"
          className="tb-item item-todo"
        >
          To do
        </button>
        <button
          onClick={() => editor.current?.wrap('\n- question: ', '')}
          title="Question: - question: … (resolve with [x] and answer: …)"
          aria-label="Insert a question"
          className="tb-item item-question"
        >
          Question
        </button>
        <button
          onClick={() => editor.current?.wrap(`\n- [ ] reminder: due:${inAWeek()} `, '')}
          title="Reminder: - [ ] reminder: … due:YYYY-MM-DD"
          aria-label="Insert a reminder"
          className="tb-item item-reminder"
        >
          Reminder
        </button>
        <span className="toolbar-sep" aria-hidden />
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
          links={links}
          onChange={(body) => change({ body })}
          onSave={() => void save()}
          onError={toast}
        />
      </Suspense>
    </article>
  );
}

/** A week from today (local), as YYYY-MM-DD: the default date for a new reminder. */
function inAWeek(): string {
  const d = new Date(Date.now() + 7 * 86_400_000);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

type VersionKey = number | 'current';

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
  // Compare: two versions picked from the list, the current one by default.
  const [compare, setCompare] = useState<VersionKey[] | null>(null);
  const { index } = useTitleIndex();
  const qc = useQueryClient();
  const toast = useToast();

  // Newest first: the current page, then earlier versions as listed.
  const order: VersionKey[] = ['current', ...(list.data?.revisions.map((r) => r.id) ?? [])];
  const pick = (k: VersionKey) =>
    setCompare((cur) => {
      if (!cur) return cur;
      if (cur.includes(k)) return cur.filter((x) => x !== k);
      // A third pick replaces the older of the two picked first.
      return cur.length < 2 ? [...cur, k] : [cur[1]!, k];
    });
  const pair =
    compare?.length === 2
      ? [...compare].sort((a, b) => order.indexOf(b) - order.indexOf(a)) // older first
      : null;

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

  const label = (k: VersionKey) => {
    if (k === 'current') return 'Current';
    const r = list.data?.revisions.find((x) => x.id === k);
    return r ? `${formatWhen(r.created_at)} (version ${r.version})` : 'Earlier version';
  };

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
          <div className="drawer-actions">
            {!!list.data?.revisions.length && (
              <button
                className={`btn small${compare ? ' primary' : ''}`}
                aria-pressed={!!compare}
                onClick={() => setCompare((c) => (c ? null : ['current']))}
              >
                <Icon name="diff" size={14} /> {compare ? 'Done comparing' : 'Compare'}
              </button>
            )}
            <button className="btn icon-only" onClick={onClose} aria-label="Close">
              <Icon name="close" />
            </button>
          </div>
        </div>
        <div className="history">
          <ul className={`history-list${compare ? ' comparing' : ''}`}>
            {compare && (
              <li className="history-hint muted">
                Pick two versions. The newer one is shown against the older.
              </li>
            )}
            {order.map((k) => {
              const r = k === 'current' ? null : list.data?.revisions.find((x) => x.id === k);
              const on = compare ? compare.includes(k) : k === 'current' ? sel === null : sel === k;
              return (
                <li key={k}>
                  <button
                    className={on ? 'current' : ''}
                    aria-pressed={compare ? on : undefined}
                    onClick={() =>
                      compare ? pick(k) : setSel(k === 'current' ? null : (k as number))
                    }
                  >
                    {compare && <span className={`history-check${on ? ' on' : ''}`} aria-hidden />}
                    <span className="history-what">
                      <strong>{r ? formatWhen(r.created_at) : 'Current'}</strong>
                      <span>
                        {r
                          ? `${actorLabel(r.actor)} · version ${r.version}${r.title !== page.title ? ` · “${r.title}”` : ''}`
                          : `${actorLabel(page.updated_by)} · ${formatWhen(page.updated_at)}`}
                      </span>
                    </span>
                  </button>
                </li>
              );
            })}
            {list.data && !list.data.revisions.length && (
              <li className="muted">No earlier versions yet.</li>
            )}
          </ul>
          <div className={`history-preview${compare ? '' : ' prose'}`}>
            {compare ? (
              pair ? (
                <ComparePair page={page} older={pair[0]!} newer={pair[1]!} label={label} />
              ) : (
                <p className="muted">
                  {compare.length ? 'Pick another version to compare with.' : 'Pick two versions.'}
                </p>
              )
            ) : sel === null ? (
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

/** Two versions' text side by side as one diff (fetched as needed). */
function ComparePair({
  page,
  older,
  newer,
  label,
}: {
  page: Page;
  older: VersionKey;
  newer: VersionKey;
  label: (k: VersionKey) => string;
}) {
  const fetchOne = (k: VersionKey) => ({
    queryKey: ['revision', page.id, k],
    queryFn: () => api.get<RevisionDetail>(`/pages/${page.id}/revisions/${k}`),
    enabled: k !== 'current',
  });
  const a = useQuery(fetchOne(older));
  const b = useQuery(fetchOne(newer));
  const text = (k: VersionKey, q: typeof a) =>
    k === 'current' ? { title: page.title, body: page.body } : q.data;
  const o = text(older, a);
  const n = text(newer, b);
  if (!o || !n) return <p className="muted">Loading…</p>;
  return <DiffView older={o} newer={n} olderLabel={label(older)} newerLabel={label(newer)} />;
}

/** Open items on this page, grouped by type; generated from the markers, never edited. */
function ItemSummary({ body }: { body: string }) {
  const open = useMemo(() => extractItems(body).filter((i) => !i.done), [body]);
  if (!open.length) return null;
  const today = todayKey();
  return (
    <aside className="item-summary" aria-label="Action items on this page">
      <h2 className="item-summary-title">
        Action items <span className="count">{open.length}</span>
      </h2>
      {ITEM_TYPES.filter((t) => open.some((i) => i.type === t)).map((t) => (
        <div key={t} className={`item-group item-${t}`}>
          <h3>
            {ITEM_PLURAL[t]}{' '}
            <span className="count">{open.filter((i) => i.type === t).length}</span>
          </h3>
          <ul>
            {open
              .filter((i) => i.type === t)
              .map((i) => (
                <li key={i.line}>
                  <a
                    href={`#item-${i.line}`}
                    onClick={(e) => {
                      e.preventDefault();
                      document
                        .getElementById(`item-${i.line}`)
                        ?.scrollIntoView({ behavior: 'smooth', block: 'center' });
                    }}
                  >
                    {plainText(i.text)}
                  </a>
                  {i.owner && <span className="muted"> · @{i.owner}</span>}
                  {i.due && (
                    <span className={i.due < today ? 'overdue' : 'muted'}>
                      {' '}
                      · {i.due < today ? 'overdue' : 'due'} {formatDue(i.due)}
                    </span>
                  )}
                </li>
              ))}
          </ul>
        </div>
      ))}
    </aside>
  );
}

const ITEM_PLURAL = { todo: 'Todos', question: 'Questions', reminder: 'Reminders' } as const;

/** Pages that name this one without linking to it, with a one-click "link it". */
function Mentions({ page }: { page: Page }) {
  const q = useQuery({
    queryKey: ['mentions', page.id, page.title],
    queryFn: () => api.get<{ mentions: Mention[] }>(`/pages/${page.id}/mentions`),
    staleTime: 60_000,
  });
  const qc = useQueryClient();
  const toast = useToast();
  const [busy, setBusy] = useState<string | null>(null);
  const list = q.data?.mentions ?? [];
  if (!list.length) return null;

  async function link(src: string) {
    setBusy(src);
    try {
      await api.post(`/pages/${page.id}/mentions/link`, { src });
      await Promise.all([
        qc.invalidateQueries({ queryKey: ['mentions', page.id] }),
        qc.invalidateQueries({ queryKey: keys.page(page.id) }),
        qc.invalidateQueries({ queryKey: keys.page(src) }),
      ]);
    } catch (e) {
      toast(errorMessage(e));
    } finally {
      setBusy(null);
    }
  }

  return (
    <section className="related" aria-label="Mentioned in">
      <div className="related-head">
        <h2>Mentioned in</h2>
        <span className="muted">Not linked yet</span>
      </div>
      <ul className="mentions">
        {list.map((m) => (
          <li key={m.id}>
            <div>
              <Link to={pageHref(m.id, m.title)}>
                <PageGlyph icon={m.icon} folder={false} /> {m.title}
              </Link>
              <p className="snippet">{m.snippet}</p>
            </div>
            <button className="btn small" disabled={busy === m.id} onClick={() => void link(m.id)}>
              <Icon name="link" size={14} /> Link
            </button>
          </li>
        ))}
      </ul>
    </section>
  );
}

/** Pages about similar things that aren't connected yet (semantic search). */
function Related({ page }: { page: Page }) {
  const q = useQuery({
    queryKey: ['related', page.id, page.version],
    queryFn: () => api.get<{ related: RelatedPage[] }>(`/pages/${page.id}/related`),
    staleTime: 10 * 60_000,
    retry: false,
  });
  const list = q.data?.related ?? [];
  if (!list.length) return null;
  return (
    <section className="related" aria-label="Related pages">
      <div className="related-head">
        <h2>Similar pages</h2>
        <span className="muted">Matched by meaning</span>
      </div>
      <ul className="backlinks related-list">
        {list.map((r) => (
          <li key={r.id}>
            <Link to={pageHref(r.id, r.title)}>
              <PageGlyph icon={r.icon} folder={false} /> {r.title}
            </Link>
            {r.path.length > 0 && <span className="muted"> · {r.path.join(' › ')}</span>}
          </li>
        ))}
      </ul>
    </section>
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
