import {
  lazy,
  Suspense,
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import { createPortal } from 'react-dom';
import { Link, Navigate, useLocation, useNavigate, useParams, useSearchParams } from 'react-router';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { actorLabel } from '@shared/actor';
import { ancestorsOf } from '@shared/tree';
import {
  extractItems,
  ITEM_TYPES,
  nowMoment,
  reminderPast,
  todayKey,
  type ItemEdit,
  type ItemType,
} from '@shared/items';
import { extractLinks, extractTags, pageHref } from '@shared/markdown';
import { glideTo, headingsOf, type Heading } from '../lib/outline';
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
import { ItemRow } from '../components/ItemRow';
import { ItemFilters } from '../components/ItemFilters';
import { DEFAULT_PAGE_ICON, Icon, PageGlyph } from '../components/Icon';
import { Outline } from '../components/Outline';
import { Markdown } from '../components/Markdown';
import { DiffView } from '../components/Diff';
import { downloadPage } from '../lib/exportMarkdown';
import { TagEditor, TagList } from '../components/Tags';
import { FitTags } from '../components/FitTags';
import { Menu } from '../components/Tree';
import { Sheet } from '../components/Sheet';
import { useToast } from '../components/Toast';
import { useTitleIndex } from '../lib/titles';
export { useTitleIndex };
import { deleteItem } from '../lib/items';
import { useDrawer } from '../lib/useDrawer';

// CodeMirror is most of the bundle; it loads with the first page, after the page itself.
const Editor = lazy(() => import('../components/Editor').then((m) => ({ default: m.Editor })));

/** Pages to offer after "@" (not AI Sessions or AI Instructions), most recently edited first, with their place in the tree. */
function useLinkTargets(): LinkTarget[] {
  const tree = useTree();
  return useMemo(() => {
    const pages = tree.data?.pages ?? [];
    const sid = tree.data?.sessions_id;
    const iid = tree.data?.instructions_id;
    const byId = new Map(pages.map((p) => [p.id, p]));
    // Not AI Sessions (or anything in it), and not the AI Instructions page.
    const system = (id: string) =>
      id === sid || id === iid || ancestorsOf(id, byId).some((a) => a.id === sid || a.id === iid);
    return pages
      .filter((p) => !system(p.id))
      .sort((a, b) => b.updated_at.localeCompare(a.updated_at))
      .map((p) => ({
        title: p.title,
        icon: p.icon,
        path: ancestorsOf(p.id, byId).map((a) => a.title),
      }));
  }, [tree.data]);
}

/**
 * A wiki page. `pageId` and `header` let another view show a page in its own frame (the
 * AI Instructions view): `header` replaces the breadcrumbs (and the ⋯ menu: only Edit and
 * History), `titleAddon` sits after the title, and the URL stays where it is.
 */
export function PageView({
  pageId,
  header,
  titleAddon,
}: { pageId?: string; header?: React.ReactNode; titleAddon?: React.ReactNode } = {}) {
  const params0 = useParams<{ id: string }>();
  const id = pageId ?? params0.id;
  const [params, setParams] = useSearchParams();
  // "?edit=1": a page just made, its title ready to type into. Read once, then dropped.
  const fresh = params.get('edit') === '1';
  const q = usePage(id);
  const tree = useTree();
  const navigate = useNavigate();

  // Keep the slug in the URL in step with the title.
  const detail = q.data;
  useEffect(() => {
    if (!detail || pageId) return;
    if (detail.page.id === tree.data?.instructions_id) return;
    const sid = tree.data?.sessions_id;
    if (sid && (detail.page.id === sid || detail.page.parent_id === sid)) return;
    const want = pageHref(detail.page.id, detail.page.title);
    if (window.location.pathname !== want)
      navigate(`${want}${window.location.search}${window.location.hash}`, { replace: true });
  }, [detail, navigate, tree.data, pageId]);

  useEffect(() => {
    if (!detail || params.get('edit') !== '1') return;
    const next = new URLSearchParams(params);
    next.delete('edit');
    setParams(next, { replace: true });
  }, [detail, params, setParams]);

  // Sessions and AI Instructions have their own views, outside the wiki.
  if (!pageId && detail && detail.page.id === tree.data?.instructions_id)
    return <Navigate to={`/instructions${window.location.search}`} replace />;
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

  return (
    <PageScreen
      key={detail!.page.id}
      detail={detail!}
      fresh={fresh}
      header={header}
      titleAddon={titleAddon}
    />
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

/**
 * A page, always ready to write in: the title, emoji and tags edit in place, the body is the live
 * preview editor, and changes save themselves a moment after you stop typing.
 */
function PageScreen({
  detail,
  fresh,
  header,
  titleAddon,
}: {
  detail: PageDetail;
  /** Just made: the title has the cursor. */
  fresh: boolean;
  header?: React.ReactNode;
  titleAddon?: React.ReactNode;
}) {
  const { page, ancestors, children, backlinks } = detail;
  const { index } = useTitleIndex();
  const links = useLinkTargets();
  const editor = useRef<EditorHandle>(null);
  const [menu, setMenu] = useState(false);
  const [history, setHistory] = useState(false);
  // The connections panel (pages inside, linked from, mentioned in, similar), open on one tab.
  const [connTab, setConnTab] = useState<ConnTab | null>(null);
  const mentions = useMentions(page);
  const related = useRelated(page);
  // Another page: the panel closes.
  const [connFor, setConnFor] = useState(page.id);
  if (connFor !== page.id) {
    setConnFor(page.id);
    setConnTab(null);
  }
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
  const draft = usePageDraft(page, !locked, (body) => editor.current?.setDoc(body));
  const { flush } = draft;

  const toggleItem = useCallback(
    async (line: number, done: boolean) => {
      try {
        await flush();
        const next = await api.post<Page>(`/pages/${page.id}/items/toggle`, { line, done });
        qc.setQueryData<PageDetail>(keys.page(page.id), (old) =>
          old ? { ...old, page: next } : old,
        );
        void qc.invalidateQueries({ queryKey: ['items'] });
      } catch (e) {
        toast(errorMessage(e));
      }
    },
    [page.id, qc, toast, flush],
  );

  const editItemAt = useCallback(
    async (line: number, edit: ItemEdit) => {
      try {
        await flush();
        const next = await api.post<Page>(`/pages/${page.id}/items/edit`, { line, ...edit });
        qc.setQueryData<PageDetail>(keys.page(page.id), (old) =>
          old ? { ...old, page: next } : old,
        );
        void qc.invalidateQueries({ queryKey: ['items'] });
      } catch (e) {
        toast(errorMessage(e));
      }
    },
    [page.id, qc, toast, flush],
  );

  const answerItem = useCallback(
    async (line: number, answer: string) => {
      try {
        await flush();
        const next = await api.post<Page>(`/pages/${page.id}/items/answer`, { line, answer });
        qc.setQueryData<PageDetail>(keys.page(page.id), (old) =>
          old ? { ...old, page: next } : old,
        );
        void qc.invalidateQueries({ queryKey: ['items'] });
      } catch (e) {
        toast(errorMessage(e));
      }
    },
    [page.id, qc, toast, flush],
  );

  const deleteItemAt = useCallback(
    async (line: number) => {
      const show = (next: Page) => {
        qc.setQueryData<PageDetail>(keys.page(page.id), (old) =>
          old ? { ...old, page: next } : old,
        );
        void qc.invalidateQueries({ queryKey: ['items'] });
        void qc.invalidateQueries({ queryKey: ['dashboard'] });
      };
      try {
        await flush();
        const { page: next, undo } = await deleteItem(page.id, line);
        show(next);
        toast('Item deleted.', {
          label: 'Undo',
          run: () =>
            void undo()
              .then(show)
              .catch((e) => toast(errorMessage(e))),
        });
      } catch (e) {
        toast(errorMessage(e));
      }
    },
    [page.id, qc, toast, flush],
  );

  const archivable = !locked && page.role !== 'ai_instructions';
  async function archive(on: boolean) {
    setMenu(false);
    const refresh = () =>
      Promise.all([
        qc.invalidateQueries({ queryKey: keys.page(page.id) }),
        qc.invalidateQueries({ queryKey: keys.tree }),
        qc.invalidateQueries({ queryKey: ['items'] }),
        qc.invalidateQueries({ queryKey: ['dashboard'] }),
      ]);
    try {
      await api.post(`/pages/${page.id}/archive`, { archived: on });
      await refresh();
      const n = (tree.data?.pages ?? []).filter((p) => p.parent_id === page.id).length;
      toast(
        on
          ? n
            ? `Archived “${page.title}” and the pages inside it.`
            : `Archived “${page.title}”.`
          : `Restored “${page.title}”.`,
        on
          ? {
              label: 'Undo',
              run: () =>
                void api
                  .post(`/pages/${page.id}/archive`, { archived: false })
                  .then(refresh)
                  .catch((e) => toast(errorMessage(e))),
            }
          : undefined,
      );
    } catch (e) {
      toast(errorMessage(e));
    }
  }

  // "Linked from" leaves out the pages already shown as this page's parent or its pages inside.
  const linkedFrom = backlinks.filter(
    (b) => b.id !== page.parent_id && !children.some((c) => c.id === b.id),
  );
  // "Linked to": the pages this one links to ([[Title]] or a link to /p/…), in the order they
  // come in the text, as it is now (each once, and not itself).
  const out = extractLinks(locked ? page.body : draft.draft.body);
  const known = [...(tree.data?.pages ?? []), ...(tree.data?.archived ?? [])];
  const linkedTo: { id: string; title: string; icon: string | null }[] = [];
  for (const id of [...out.titles.map((t) => index.get(t)?.id), ...out.ids]) {
    if (!id || id === page.id || linkedTo.some((x) => x.id === id)) continue;
    const p = known.find((x) => x.id === id);
    if (p) linkedTo.push({ id: p.id, title: p.title, icon: ('icon' in p && p.icon) || null });
  }
  const connections: Connection[] = [
    ...(locked === 'entry'
      ? []
      : [
          {
            tab: 'inside' as const,
            n: children.length,
            icon: 'folder',
            chip: locked === 'root' ? 'sessions' : 'inside',
            name: locked === 'root' ? 'Sessions' : 'Inside',
          },
        ]),
    { tab: 'linkedTo', n: linkedTo.length, icon: 'external', chip: 'linked to', name: 'Linked to' },
    { tab: 'linked', n: linkedFrom.length, icon: 'link', chip: 'linked from', name: 'Linked from' },
    {
      tab: 'mentions',
      n: mentions.list.length,
      icon: 'quote',
      chip: mentions.list.length === 1 ? 'mention' : 'mentions',
      name: 'Mentioned in',
    },
    { tab: 'similar', n: related.length, icon: 'sparkle', chip: 'similar', name: 'Similar' },
  ];

  // Open Items above the text grows or shrinks as you write items: while you're writing, the
  // page scrolls by the same amount, so the line you're on stays where it is.
  const summaryBox = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const box = summaryBox.current;
    if (!box) return;
    // The box's own height, from what's in it (not the height it's being held at while it eases).
    const natural = () => (box.firstElementChild as HTMLElement | null)?.offsetHeight ?? 0;
    let last = natural();
    // The box's own height last time (its margins and padding included).
    let lastBox = box.offsetHeight;
    // Ticking an item off in the page (its box takes no focus) counts as writing too.
    let ticked = 0;
    const onTick = (e: MouseEvent) => {
      if ((e.target as HTMLElement).closest?.('.cm-check')) ticked = performance.now();
    };
    document.addEventListener('mousedown', onTick, true);
    const scroller = () => {
      const main = box.closest<HTMLElement>('.main');
      return main &&
        main.scrollHeight > main.clientHeight &&
        getComputedStyle(main).overflowY !== 'visible'
        ? main
        : null;
    };
    let easing = 0;
    const ro = new ResizeObserver(() => {
      const h = natural();
      const delta = h - last;
      const from = lastBox;
      last = h;
      lastBox = Math.max(0, from + delta);
      const writing =
        document.activeElement?.closest('.cm-editor') || performance.now() - ticked < 1500;
      if (!delta || !writing) return;
      const main = scroller();
      const top = main ? main.scrollTop : window.scrollY;
      // Shrinking near the top of the page, there's no scroll to give back: rather than the text
      // under it jumping up, the box eases down to its new height.
      if (delta < 0 && top + delta < 0) {
        window.clearTimeout(easing);
        // Where it ends up: its height with nothing holding it.
        box.style.transition = '';
        box.style.height = '';
        const to = box.offsetHeight;
        lastBox = to;
        box.style.height = `${from}px`;
        box.style.overflow = 'hidden';
        void box.offsetHeight;
        box.style.transition = 'height 0.26s cubic-bezier(0.25, 0.8, 0.25, 1)';
        box.style.height = `${to}px`;
        easing = window.setTimeout(() => {
          box.style.height = '';
          box.style.overflow = '';
          box.style.transition = '';
        }, 300);
        return;
      }
      if (main) main.scrollTop += delta;
      else window.scrollBy(0, delta);
    });
    // Watch what's in the box (the list comes and goes as items open and close).
    const watch = () => {
      ro.disconnect();
      if (box.firstElementChild) ro.observe(box.firstElementChild);
      last = natural();
      lastBox = box.offsetHeight;
    };
    const mo = new MutationObserver(watch);
    mo.observe(box, { childList: true });
    watch();
    return () => {
      ro.disconnect();
      mo.disconnect();
      window.clearTimeout(easing);
      document.removeEventListener('mousedown', onTick, true);
    };
  }, [locked]);

  // "E" puts the cursor in the page.
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
        editor.current?.focus();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [locked]);

  // Scroll to a #h-… or #item-… anchor once the body is there, once per page and anchor:
  // checking off or editing an item changes the body, and that mustn't jump back to the item.
  const { hash, pathname, search } = useLocation();
  const anchored = useRef<string | null>(null);
  const [editorReady, setEditorReady] = useState(false);
  useEffect(() => {
    const target = `${page.id}${hash}`;
    if (!hash || anchored.current === target) return;
    if (locked) {
      const el = document.getElementById(decodeURIComponent(hash.slice(1)));
      if (!el) return;
      anchored.current = target;
      el.scrollIntoView();
      return;
    }
    if (!editorReady) return;
    anchored.current = target;
    const line = anchorLine(page.body, hash);
    if (line) requestAnimationFrame(() => editor.current?.scrollToLine(line));
  }, [page.id, page.body, hash, locked, editorReady]);

  // The outline: the page's headings (three levels), as written so far.
  const body = locked ? page.body : draft.draft.body;
  const headings = useMemo(() => headingsOf(body, 3), [body]);
  const [outlinePinned, setOutlinePinned] = useState(false);
  // The page slides over only while the outline is being pinned or hidden. (Left on all the time,
  // that slide fought the sidebar's: the target moves every frame as the column widens.)
  const [outlineMoving, setOutlineMoving] = useState(false);
  const firstPin = useRef(true);
  useEffect(() => {
    if (firstPin.current) {
      firstPin.current = false;
      return;
    }
    setOutlineMoving(true);
    const t = window.setTimeout(() => setOutlineMoving(false), 420);
    return () => window.clearTimeout(t);
  }, [outlinePinned]);
  const bodyRef = useRef<HTMLDivElement>(null);
  // The top bar gets its hairline only once the page has scrolled under it.
  const topRef = useRef<HTMLDivElement>(null);
  const [stuck, setStuck] = useState(false);
  useEffect(() => {
    const main = topRef.current?.closest<HTMLElement>('.main');
    const check = () => {
      const scrolls =
        main &&
        main.scrollHeight > main.clientHeight &&
        getComputedStyle(main).overflowY !== 'visible';
      setStuck((scrolls ? main.scrollTop : window.scrollY) > 4);
    };
    check();
    document.addEventListener('scroll', check, { capture: true, passive: true });
    return () => document.removeEventListener('scroll', check, { capture: true });
  }, []);
  // Where a heading is on screen now: its rendered element, or its line in the editor.
  const headingTop = (h: Heading) =>
    locked
      ? document.getElementById(`h-${h.id}`)?.getBoundingClientRect().top
      : editor.current?.lineTop(h.line);
  const goToHeading = (h: Heading) => {
    const from = bodyRef.current;
    const y = headingTop(h);
    if (from && y != null) glideTo(from, y);
    else editor.current?.scrollToLine(h.line);
  };

  async function addChild() {
    try {
      const p = await create.mutateAsync({ title: 'Untitled', parent_id: page.id });
      navigate(`${pageHref(p.id, p.title)}?edit=1`);
    } catch (e) {
      toast(errorMessage(e));
    }
  }

  async function pin() {
    setMenu(false);
    try {
      await api.post(`/pages/${page.id}/pin`, { pinned: !page.pinned_at });
      await qc.invalidateQueries({ queryKey: keys.page(page.id) });
      void qc.invalidateQueries({ queryKey: ['dashboard'] });
      toast(page.pinned_at ? 'Unpinned from Home.' : 'Pinned to Home.');
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
    <article
      className={`page${outlinePinned ? ' outline-pinned' : ''}${outlineMoving ? ' outline-moving' : ''}`}
    >
      <div className={`page-top${stuck ? ' stuck' : ''}`} ref={topRef}>
        {header ?? (
          <Breadcrumbs
            ancestors={ancestors}
            page={{ title: locked ? page.title : draft.draft.title || 'Untitled' }}
          />
        )}
        <div className="page-actions">
          {!locked && draft.touched && (
            <span className={`save-state ${draft.state}`} aria-live="polite">
              {SAVE_LABEL[draft.state]}
            </span>
          )}
          <button
            className="btn icon-only"
            onClick={() => setHistory(true)}
            aria-label="History"
            title="History"
          >
            <Icon name="history" size={15} />
          </button>
          {!header && (
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
                      <Icon name="plus" size={15} /> Add subpage
                    </button>
                  )}
                  <button role="menuitem" onClick={pin}>
                    <Icon name="pin" size={15} />
                    {page.pinned_at ? 'Unpin from Home' : 'Pin to Home'}
                  </button>
                  <button
                    role="menuitem"
                    onClick={() => {
                      setMenu(false);
                      void navigator.clipboard?.writeText(`[[${page.title}]]`);
                      toast('Link copied. Paste it into another page.');
                    }}
                  >
                    <Icon name="link" size={15} /> Copy link to page
                  </button>
                  <button
                    role="menuitem"
                    onClick={() => {
                      setMenu(false);
                      downloadPage(page);
                    }}
                  >
                    <Icon name="download" size={15} /> Download as Markdown
                  </button>
                  {archivable && (
                    <button role="menuitem" onClick={() => void archive(!page.archived_at)}>
                      <Icon name={page.archived_at ? 'unarchive' : 'archive'} size={15} />
                      {page.archived_at ? 'Restore from archive' : 'Archive'}
                    </button>
                  )}
                  {!locked && (
                    <button role="menuitem" className="danger" onClick={remove}>
                      <Icon name="trash" size={15} /> Delete
                    </button>
                  )}
                </Menu>
              )}
            </div>
          )}
        </div>
      </div>
      <header className="page-head">
        {/* The emoji just left of the title, on the same line. */}
        {locked ? (
          <div className="page-title-row">
            <div className="page-icon">{page.icon || DEFAULT_PAGE_ICON}</div>
            <h1 className="page-title">
              {page.title}
              {titleAddon && <span className="title-addon">{titleAddon}</span>}
            </h1>
            {/* Phones: the outline's button, at the right end of the title row. */}
            <Outline place="title" headings={headings} onGo={goToHeading} topOf={headingTop} />
          </div>
        ) : (
          <div className="page-title-row live-title">
            {/* Every page has its icon here (📄 until one is chosen): tap it to change it. */}
            <EmojiButton value={draft.draft.icon} onChange={(icon) => draft.change({ icon })} />
            <TitleField
              value={draft.draft.title}
              onChange={(title) => draft.change({ title })}
              onEnter={() => editor.current?.focus('start')}
              focus={fresh}
            />
            {titleAddon && <span className="title-addon">{titleAddon}</span>}
            <Outline place="title" headings={headings} onGo={goToHeading} topOf={headingTop} />
          </div>
        )}
        {/* One quiet line under the title: its tags. (Who changed what, and when, is in History.) */}
        <div className="page-meta-row">
          {locked ? (
            <TagList tags={detail.all_tags} from={page.title} />
          ) : (
            <TagEditor
              tags={draft.draft.tags}
              bodyTags={extractTags(draft.draft.body)}
              onChange={(tags) => draft.change({ tags })}
              from={draft.draft.title || page.title}
            />
          )}
          {/* What the page is connected to: a chip for each kind there is, opening its panel. */}
          {connections.some((c) => c.n > 0) && (!locked || detail.all_tags.length > 0) && (
            <span className="meta-sep" aria-hidden>
              |
            </span>
          )}
          {connections.some((c) => c.n > 0) && (
            <div className="conn-chips">
              {connections
                .filter((c) => c.n > 0)
                .map((c) => (
                  <button
                    key={c.tab}
                    type="button"
                    className="conn-chip"
                    aria-haspopup="dialog"
                    onClick={() => setConnTab(c.tab)}
                  >
                    <Icon name={c.icon} size={13} />
                    {c.n} {c.chip}
                  </button>
                ))}
            </div>
          )}
        </div>
      </header>
      {draft.banners}
      {page.archived_at && (
        <div className="banner archived-banner" role="status">
          <p>
            <Icon name="archive" size={15} /> Archived {formatWhen(page.archived_at)}.
          </p>
          <button className="btn small" onClick={() => void archive(false)}>
            <Icon name="unarchive" size={14} /> Restore
          </button>
        </div>
      )}
      {locked && (
        <p className="locked-note">
          <Icon name="lock" size={14} />{' '}
          {locked === 'root'
            ? 'Assistants record their sessions here automatically. Read-only.'
            : 'Recorded automatically from what the assistant did. Read-only.'}
        </p>
      )}
      {/* The page's body. */}
      <div className="doc-body" ref={bodyRef}>
        <Outline
          headings={headings}
          onGo={goToHeading}
          topOf={headingTop}
          onPinned={setOutlinePinned}
        />
        {!locked && (
          <div ref={summaryBox} className="item-summary-box">
            <ItemSummary
              key={page.id}
              page={page}
              body={draft.draft.body}
              onDone={toggleItem}
              onAnswer={answerItem}
              onEdit={editItemAt}
              onDelete={deleteItemAt}
            />
          </div>
        )}
        <div className="prose">
          {locked ? (
            page.body.trim() && <Markdown source={page.body} titles={index} noItems />
          ) : (
            // Until the editor's code arrives, the page as it reads.
            <Suspense fallback={<Markdown source={page.body} titles={index} />}>
              <Editor
                ref={editor}
                value={draft.draft.body}
                pageId={page.id}
                links={links}
                titles={index}
                onChange={(body) => draft.change({ body })}
                onSave={() => void draft.save()}
                onError={toast}
                onNavigate={(href) =>
                  // A #tag in the text: its page's back link comes back here.
                  navigate(
                    href,
                    href.startsWith('/tags/')
                      ? { state: { from: { href: pathname + search, title: page.title } } }
                      : undefined,
                  )
                }
                onReady={() => setEditorReady(true)}
              />
            </Suspense>
          )}
        </div>
      </div>

      {connTab && (
        <ConnectionsPanel
          tabs={connections.filter((c) => c.n > 0 || c.tab === connTab)}
          tab={connTab}
          onTab={setConnTab}
          onClose={() => setConnTab(null)}
        >
          {connTab === 'inside' && (
            <>
              {!locked && (
                <button className="btn small conn-add" onClick={addChild}>
                  <Icon name="plus" size={14} /> Add subpage
                </button>
              )}
              {/* One full-width row each: title, then when and by whom, with its tags on the right. */}
              <ul className="child-list">
                {children.map((c) => (
                  <li key={c.id} className="child-row">
                    <PageGlyph icon={c.icon} folder={false} />
                    <div className="child-text">
                      <Link to={pageHref(c.id, c.title)} className="child-title">
                        {c.title}
                      </Link>
                      <span className="child-meta">
                        Updated {formatWhen(c.updated_at)}
                        {c.updated_by && ` by ${actorLabel(c.updated_by)}`}
                        {c.created_by && c.created_by !== c.updated_by
                          ? ` · created by ${actorLabel(c.created_by)}`
                          : ''}
                      </span>
                    </div>
                    {c.tags?.length > 0 && <FitTags tags={c.tags} />}
                  </li>
                ))}
              </ul>
            </>
          )}
          {connTab === 'linkedTo' && (
            <ul className="backlinks">
              {linkedTo.map((b) => (
                <li key={b.id}>
                  <Link to={pageHref(b.id, b.title)}>
                    <PageGlyph icon={b.icon} folder={false} />{' '}
                    <span className="conn-title">{b.title}</span>
                  </Link>
                </li>
              ))}
            </ul>
          )}
          {connTab === 'linked' && (
            <ul className="backlinks">
              {linkedFrom.map((b) => (
                <li key={b.id}>
                  <Link to={pageHref(b.id, b.title)}>
                    <PageGlyph icon={b.icon} folder={false} />{' '}
                    <span className="conn-title">{b.title}</span>
                  </Link>
                </li>
              ))}
            </ul>
          )}
          {connTab === 'mentions' && <MentionList m={mentions} />}
          {connTab === 'similar' && (
            <ul className="backlinks related-list">
              {related.map((x) => (
                <li key={x.id}>
                  <Link to={pageHref(x.id, x.title)}>
                    <PageGlyph icon={x.icon} folder={false} />{' '}
                    <span className="conn-title">{x.title}</span>
                  </Link>
                  {x.path.length > 0 && <span className="muted"> · {x.path.join(' › ')}</span>}
                </li>
              ))}
            </ul>
          )}
        </ConnectionsPanel>
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
  tags: string[];
  base: number;
}

const SAVE_LABEL: Record<SaveState, string> = {
  saved: 'Saved',
  dirty: 'Unsaved',
  saving: 'Saving…',
  error: 'Not saved',
  conflict: 'Changed elsewhere',
};

const sameTags = (a: string[] | undefined, b: string[] | undefined) =>
  JSON.stringify(a ?? []) === JSON.stringify(b ?? []);

const fromPage = (page: Page): Draft => ({
  title: page.title,
  icon: page.icon ?? '',
  body: page.body,
  tags: page.tags,
  base: page.version,
});

/**
 * The page as it's being written: changes save a moment after typing stops (and on leaving),
 * against the version they started from. A newer version from elsewhere (an assistant, an item
 * checked off in Open Items, a restored revision) is taken in when nothing is waiting to save;
 * otherwise saving reports the clash and offers both ways out.
 */
function usePageDraft(page: Page, editable: boolean, onExternal: (body: string) => void) {
  const qc = useQueryClient();
  const toast = useToast();
  const draftKey = `n2.draft.${page.id}`;
  const [draft, setDraft] = useState<Draft>(() => fromPage(page));
  const [state, setStateValue] = useState<SaveState>('saved');
  // "Saved" shows once you've changed something on this visit.
  const [touched, setTouched] = useState(false);
  const [stale] = useState<Draft | null>(() => {
    if (!editable) return null;
    const d = readLocal<Draft | null>(draftKey, null);
    return d && (d.body !== page.body || d.title !== page.title) ? d : null;
  });
  const [offerDraft, setOfferDraft] = useState(!!stale);
  // The latest draft and state for async saves.
  const current = useRef(draft);
  const stateRef = useRef<SaveState>('saved');
  const saving = useRef<Promise<void> | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout>>(undefined);
  const external = useRef(onExternal);
  useEffect(() => {
    external.current = onExternal;
  });
  const setState = useCallback((s: SaveState) => {
    stateRef.current = s;
    setStateValue(s);
  }, []);

  // The latest save, for timers and handlers set up before it last changed.
  const saveRef = useRef<(force?: boolean) => Promise<void>>(async () => undefined);
  const save = useCallback(
    async (force = false): Promise<void> => {
      clearTimeout(timer.current);
      if (saving.current) await saving.current;
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
        if (stateRef.current !== 'conflict') setState('saved');
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
          current.current = { ...current.current, base: next.version };
          setDraft((cur) => ({ ...cur, base: next.version }));
          // The tags under the title show at once: the page's own plus #tags in the body.
          const allTags = [...new Set([...next.tags, ...extractTags(next.body)])].sort();
          qc.setQueryData<PageDetail>(keys.page(page.id), (old) =>
            old ? { ...old, page: next, all_tags: allTags } : old,
          );
          if (!cached || cached.title !== next.title || cached.icon !== next.icon)
            void qc.invalidateQueries({ queryKey: keys.tree });
          if (!cached || !sameTags(cached.tags, next.tags) || cached.body !== next.body) {
            // The Tags view and each tag's page list pages by tag; Open Items read the body.
            void qc.invalidateQueries({ queryKey: ['tags'] });
            void qc.invalidateQueries({ queryKey: ['tag'] });
            void qc.invalidateQueries({ queryKey: ['items'] });
            void qc.invalidateQueries({ queryKey: ['dashboard'] });
          }
          const latest = current.current;
          if (
            latest.body === d.body &&
            latest.title === d.title &&
            latest.icon === d.icon &&
            sameTags(latest.tags, d.tags)
          ) {
            writeLocal(draftKey, undefined);
            setState('saved');
          } else {
            setState('dirty');
            timer.current = setTimeout(() => void saveRef.current(), 1200);
          }
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
    [page.id, qc, toast, draftKey, setState],
  );
  useEffect(() => {
    saveRef.current = save;
  });

  const change = useCallback(
    (patch: Partial<Draft>) => {
      const next = { ...current.current, ...patch };
      current.current = next;
      setDraft(next);
      writeLocal(draftKey, next);
      setTouched(true);
      if (stateRef.current !== 'conflict') {
        setState('dirty');
        clearTimeout(timer.current);
        timer.current = setTimeout(() => void saveRef.current(), 1200);
      }
    },
    [draftKey, setState],
  );

  /** Saves anything waiting, before an action that changes the page on the server. */
  const flush = useCallback(async () => {
    if (stateRef.current === 'dirty' || saving.current) await saveRef.current();
  }, []);

  // A newer version from elsewhere, with nothing of ours waiting: take it in.
  useEffect(() => {
    const d = current.current;
    if (!editable || page.version <= d.base) return;
    if (stateRef.current !== 'saved' || saving.current) return;
    const next = fromPage(page);
    current.current = next;
    setDraft(next);
    external.current(next.body);
  }, [page, editable]);

  // Save before closing the tab, and when leaving the page in the app.
  useEffect(() => {
    const before = (e: BeforeUnloadEvent) => {
      if (stateRef.current === 'dirty' || stateRef.current === 'saving') {
        void saveRef.current();
        e.preventDefault();
      }
    };
    window.addEventListener('beforeunload', before);
    return () => {
      window.removeEventListener('beforeunload', before);
      clearTimeout(timer.current);
      if (stateRef.current === 'dirty') void saveRef.current();
    };
  }, []);

  async function loadLatest() {
    await navigator.clipboard?.writeText(current.current.body).catch(() => undefined);
    const fresh = await qc.fetchQuery({
      queryKey: keys.page(page.id),
      queryFn: () => api.get<PageDetail>(`/pages/${page.id}`),
      staleTime: 0,
    });
    const d = fromPage(fresh.page);
    current.current = d;
    setDraft(d);
    external.current(d.body);
    writeLocal(draftKey, undefined);
    setState('saved');
    toast('Loaded the latest version. Your text was copied to the clipboard.');
  }

  const banners = (
    <>
      {state === 'conflict' && (
        <div className="banner warn" role="alert">
          <p>Someone (or an assistant) changed this page while you were writing.</p>
          <div>
            <button className="btn small" onClick={() => void loadLatest()}>
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
          <p>You have unsaved changes from an earlier visit.</p>
          <div>
            <button
              className="btn small"
              onClick={() => {
                change({
                  title: stale.title,
                  icon: stale.icon,
                  body: stale.body,
                  tags: stale.tags ?? current.current.tags,
                });
                external.current(stale.body);
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
    </>
  );

  return { draft, change, save, flush, state, touched, banners };
}

/** The page title, edited in place: wraps like a heading, Enter goes to the text. */
function TitleField({
  value,
  onChange,
  onEnter,
  focus,
}: {
  value: string;
  onChange(title: string): void;
  onEnter(): void;
  /** Start with the cursor here (a page just made: "Untitled" selected, to type over). */
  focus: boolean;
}) {
  const ref = useRef<HTMLTextAreaElement>(null);
  const fit = useCallback(() => {
    const t = ref.current;
    if (!t) return;
    t.style.height = '0px';
    t.style.height = `${t.scrollHeight}px`;
  }, []);
  useLayoutEffect(fit, [value, fit]);
  useEffect(() => {
    window.addEventListener('resize', fit);
    return () => window.removeEventListener('resize', fit);
  }, [fit]);
  useEffect(() => {
    if (!focus) return;
    ref.current?.focus();
    if (ref.current?.value === 'Untitled') ref.current.select();
  }, [focus]);
  return (
    <textarea
      ref={ref}
      className="page-title title-field"
      rows={1}
      value={value}
      placeholder="Untitled"
      aria-label="Title"
      spellCheck
      onChange={(e) => onChange(e.target.value.replace(/\n/g, ' '))}
      onKeyDown={(e) => {
        if (e.key === 'Enter') {
          e.preventDefault();
          onEnter();
        }
      }}
    />
  );
}

/** The line a #h-heading or #item-line anchor points at, in the page's markdown. */
function anchorLine(body: string, hash: string): number | null {
  const id = decodeURIComponent(hash.slice(1));
  const item = /^item-(\d+)$/.exec(id);
  if (item) return Number(item[1]);
  if (!id.startsWith('h-')) return null;
  return headingsOf(body).find((h) => h.id === id.slice(2))?.line ?? null;
}

type VersionKey = number | 'current';

/**
 * A panel that slides out from the right closes by sliding back first: `close` starts that, and
 * `done` runs once it's out of sight.
 */
function useSlideClose(done: () => void): [boolean, () => void] {
  const [closing, setClosing] = useState(false);
  const close = () => {
    if (closing) return;
    // Phones don't slide it: it just closes.
    if (window.matchMedia('(max-width: 860px)').matches) return done();
    setClosing(true);
    setTimeout(done, 220);
  };
  return [closing, close];
}

function HistoryPanel({ page, onClose: done }: { page: Page; onClose(): void }) {
  const [closing, onClose] = useSlideClose(done);
  const list = useQuery({
    queryKey: keys.revisions(page.id),
    queryFn: () => api.get<{ revisions: Revision[] }>(`/pages/${page.id}/revisions`),
  });
  const [sel, setSel] = useState<number | null>(null);
  // Phones show one thing at a time: the list of versions, or (after a tap) the version itself.
  const [showing, setShowing] = useState(false);
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
  // While it's open the page behind doesn't scroll (on phones it would take over the scroll).
  useEffect(() => {
    document.documentElement.classList.add('nav-locked');
    return () => document.documentElement.classList.remove('nav-locked');
  }, []);

  // Newest first: the current page, then earlier versions as listed.
  const order: VersionKey[] = ['current', ...(list.data?.revisions.map((r) => r.id) ?? [])];
  const pick = (k: VersionKey) => {
    if (!compare) return;
    const next = compare.includes(k)
      ? compare.filter((x) => x !== k)
      : // A third pick replaces the older of the two picked first.
        compare.length < 2
        ? [...compare, k]
        : [compare[1]!, k];
    setCompare(next);
    // Two picked: on phones, show the comparison.
    if (next.length === 2) setShowing(true);
  };
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

  // Over everything, the outline included (it lives outside the page too).
  return createPortal(
    <div className={`scrim drawer-scrim${closing ? ' closing' : ''}`} onMouseDown={onClose}>
      <div
        className="drawer"
        role="dialog"
        aria-label="Page history"
        onMouseDown={(e) => e.stopPropagation()}
      >
        <div className="drawer-head">
          {showing && (
            <button
              className="btn icon-only mobile-only history-back"
              onClick={() => setShowing(false)}
              aria-label="Back to versions"
            >
              <Icon name="back" />
            </button>
          )}
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
        <div className={`history${showing ? ' showing' : ''}`}>
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
                    onClick={() => {
                      if (compare) return pick(k);
                      setSel(k === 'current' ? null : (k as number));
                      setShowing(true);
                    }}
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
    </div>,
    document.body,
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

/**
 * This page's open items, at the top: the same rows as the Open Items page, so a to-do can be
 * checked off, a question answered, a date changed or an item deleted right here as well as where
 * it's written. Its header stays pinned while the list scrolls under it, and a tap on the header
 * folds the list away (remembered on this device).
 */
const SUMMARY_SORTS = [
  ['page', 'Page order'],
  ['due', 'Due date'],
] as const;
const SUMMARY_GROUPS = [
  ['none', 'None'],
  ['type', 'Type'],
] as const;
const TYPE_GROUP: Record<ItemType, string> = {
  todo: 'To Dos',
  question: 'Questions',
  reminder: 'Reminders',
};

function ItemSummary({
  page,
  body,
  onDone,
  onAnswer,
  onEdit,
  onDelete,
}: {
  page: Page;
  /** The page's text as it is on screen (it saves a moment later). */
  body: string;
  onDone(line: number, done: boolean): Promise<void>;
  onAnswer(line: number, answer: string): Promise<void>;
  onEdit(line: number, edit: ItemEdit): Promise<void>;
  onDelete(line: number): Promise<void>;
}) {
  const [open, setOpen] = useState(() => readLocal('n2.items.open', true));
  const drawer = useDrawer<HTMLDivElement>(open);
  const toggle = () =>
    setOpen((o) => {
      writeLocal('n2.items.open', !o);
      return !o;
    });
  const items = useMemo(() => extractItems(body), [body]);
  const now = nowMoment();
  // Open to-dos and questions, and reminders still ahead (past ones were just nudges).
  const isOpen = (i: (typeof items)[number]) => !i.done && !reminderPast(i, now);
  const keyOf = (i: (typeof items)[number]) => `${i.line}:${i.text}`;
  // An item checked off or answered here stays listed (struck through, with its answer) until
  // you leave, so the box doesn't shrink under your finger, a mis-tap is one tap to undo, and you
  // see what you wrote. Checked off in the page itself, it goes at once (the page holds its place,
  // see the summary box's resize handling above).
  const keepKey = (i: (typeof items)[number]) => `${i.type}:${i.text}`;
  const [kept, setKept] = useState<string[]>([]);
  const [sort, setSort] = useState<'page' | 'due'>(() => readLocal('n2.page-items.sort', 'page'));
  const [group, setGroup] = useState<'none' | 'type'>(() =>
    readLocal('n2.page-items.group', 'none'),
  );
  const [showDone, setShowDone] = useState(() => readLocal('n2.page-items.done', false));
  const anyDone = items.some((i) => !isOpen(i));
  const listed = items.filter((i) => showDone || isOpen(i) || kept.includes(keepKey(i)));
  if (!listed.length) return null;
  // By due date: soonest first (a time before none on the same day), undated last, then by line.
  const when = (i: (typeof items)[number]) =>
    i.due ? `${i.due} ${i.due_time ?? '99:99'}` : '\uffff';
  const list =
    sort === 'due'
      ? [...listed].sort((a, b) => when(a).localeCompare(when(b)) || a.line - b.line)
      : listed;
  const today = todayKey();
  // With completed shown, the counts are of everything listed; otherwise of what's still open.
  const tally = (of: typeof list) => (showDone ? of.length : of.filter(isOpen).length);
  const count = tally(list);
  const row = (i: (typeof items)[number]) => (
    <ItemRow
      key={keyOf(i)}
      item={{
        ...i,
        page_id: page.id,
        page_title: page.title,
        page_icon: page.icon,
        path: [],
      }}
      today={today}
      inPage
      onDone={(d) => {
        if (d) setKept((k) => [...k, keepKey(i)]);
        void onDone(i.line, d);
      }}
      onAnswer={(t) => {
        // Answering resolves it: it stays listed, with its answer, like one ticked here.
        setKept((k) => [...k, keepKey(i)]);
        return onAnswer(i.line, t);
      }}
      onEdit={(edit) => onEdit(i.line, edit)}
      onDelete={() => void onDelete(i.line)}
    />
  );
  return (
    <aside className={`item-summary${open ? ' open' : ''}`} aria-label="Action Items on this page">
      <h2 className="item-summary-title">
        <button
          type="button"
          className="item-summary-head"
          aria-expanded={open}
          aria-controls={`items-${page.id}`}
          onClick={toggle}
        >
          <Icon name="checks" size={16} /> Action Items <span className="count">{count}</span>
          <span className="item-summary-chev" aria-hidden>
            <Icon name="chevron" size={16} />
          </span>
        </button>
        {open && (list.length > 1 || anyDone) && (
          <div className="item-summary-tools">
            <ItemFilters
              title="Action Items"
              choices={[
                {
                  label: 'Sort',
                  value: sort,
                  initial: 'page',
                  options: SUMMARY_SORTS,
                  onChange: (v: string) => {
                    setSort(v as 'page' | 'due');
                    writeLocal('n2.page-items.sort', v);
                  },
                },
                {
                  label: 'Group by',
                  value: group,
                  initial: 'none',
                  options: SUMMARY_GROUPS,
                  onChange: (v: string) => {
                    setGroup(v as 'none' | 'type');
                    writeLocal('n2.page-items.group', v);
                  },
                },
                ...(anyDone
                  ? [
                      {
                        label: 'Completed',
                        value: showDone ? 'show' : 'hide',
                        initial: 'hide',
                        options: [
                          ['hide', 'Hide'],
                          ['show', 'Show'],
                        ] as const,
                        toggle: {
                          on: 'show',
                          off: 'hide',
                          labels: ['Show completed', 'Hide completed'] as [string, string],
                        },
                        onChange: (v: string) => {
                          // Hiding takes everything finished out, including what was just checked off here.
                          if (v === 'hide') setKept([]);
                          setShowDone(v === 'show');
                          writeLocal('n2.page-items.done', v === 'show');
                        },
                      },
                    ]
                  : []),
              ]}
            />
          </div>
        )}
      </h2>
      <div className="item-summary-drawer" ref={drawer} id={`items-${page.id}`} inert={!open}>
        <div className="item-summary-inner">
          {group === 'type' ? (
            ITEM_TYPES.map((t) => {
              const of = list.filter((i) => i.type === t);
              if (!of.length) return null;
              return (
                <div key={t} className="item-summary-group">
                  <h3 className="item-summary-sub">
                    {TYPE_GROUP[t]} <span className="count">{tally(of)}</span>
                  </h3>
                  <ul className="items-full">{of.map(row)}</ul>
                </div>
              );
            })
          ) : (
            <ul className="items-full">{list.map(row)}</ul>
          )}
        </div>
      </div>
    </aside>
  );
}

/** Pages that name this one without linking to it, with a one-click "link it". */
type ConnTab = 'inside' | 'linkedTo' | 'linked' | 'mentions' | 'similar';
interface Connection {
  tab: ConnTab;
  n: number;
  icon: string;
  /** After the count on its chip ("4 inside"). */
  chip: string;
  /** Its tab's name in the panel. */
  name: string;
}

/**
 * Everything a page is connected to, in one panel with a tab each: a panel on the right on
 * computers, a sheet from the bottom on phones.
 */
function ConnectionsPanel({
  tabs,
  tab,
  onTab,
  onClose: done,
  children,
}: {
  tabs: Connection[];
  tab: ConnTab;
  onTab(t: ConnTab): void;
  onClose(): void;
  children: React.ReactNode;
}) {
  const [phone] = useState(() => window.matchMedia('(max-width: 860px)').matches);
  const [closing, onClose] = useSlideClose(done);
  useEffect(() => {
    if (phone) return;
    const esc = (e: KeyboardEvent) => e.key === 'Escape' && onClose();
    document.addEventListener('keydown', esc);
    return () => document.removeEventListener('keydown', esc);
  }, [phone, onClose]);
  const body = (
    <>
      <div className="conn-tabs" role="tablist" aria-label="Connections">
        {tabs.map((t) => (
          <button
            key={t.tab}
            type="button"
            role="tab"
            aria-selected={t.tab === tab}
            className={t.tab === tab ? 'on' : undefined}
            onClick={() => onTab(t.tab)}
          >
            <Icon name={t.icon} size={14} />
            {t.name}
            <span className="count">{t.n}</span>
          </button>
        ))}
      </div>
      <div className="conn-body" role="tabpanel">
        {children}
      </div>
    </>
  );
  if (phone)
    return (
      <Sheet title="Connections" onClose={done}>
        {body}
      </Sheet>
    );
  return createPortal(
    <div className={`scrim drawer-scrim${closing ? ' closing' : ''}`} onMouseDown={onClose}>
      <div
        className="drawer conn-drawer"
        role="dialog"
        aria-label="Connections"
        onMouseDown={(e) => e.stopPropagation()}
      >
        <div className="drawer-head">
          <h2>Connections</h2>
          <button className="btn icon-only" onClick={onClose} aria-label="Close">
            <Icon name="close" />
          </button>
        </div>
        {body}
      </div>
    </div>,
    document.body,
  );
}

/** Pages that name this one without linking to it, and a way to link each. */
function useMentions(page: Page) {
  const q = useQuery({
    queryKey: ['mentions', page.id, page.title],
    queryFn: () => api.get<{ mentions: Mention[] }>(`/pages/${page.id}/mentions`),
    staleTime: 60_000,
  });
  const qc = useQueryClient();
  const toast = useToast();
  const [busy, setBusy] = useState<string | null>(null);
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
  return { list: q.data?.mentions ?? [], busy, link };
}

function MentionList({ m }: { m: ReturnType<typeof useMentions> }) {
  return (
    <ul className="mentions">
      {m.list.map((x) => (
        <li key={x.id}>
          <div>
            <Link to={pageHref(x.id, x.title)}>
              <PageGlyph icon={x.icon} folder={false} />{' '}
              <span className="conn-title">{x.title}</span>
            </Link>
            <p className="snippet">{x.snippet}</p>
          </div>
          <button
            className="btn small"
            disabled={m.busy === x.id}
            onClick={() => void m.link(x.id)}
          >
            <Icon name="link" size={14} /> Link
          </button>
        </li>
      ))}
    </ul>
  );
}

/** Pages about similar things that aren't connected yet (semantic search). */
function useRelated(page: Page): RelatedPage[] {
  const q = useQuery({
    queryKey: ['related', page.id, page.version],
    queryFn: () => api.get<{ related: RelatedPage[] }>(`/pages/${page.id}/related`),
    staleTime: 10 * 60_000,
    retry: false,
  });
  return q.data?.related ?? [];
}

export function formatWhen(iso: string): string {
  const d = new Date(iso);
  const diff = (Date.now() - d.getTime()) / 1000;
  if (diff < 60) return 'just now';
  if (diff < 3600) return `${Math.floor(diff / 60)}m ago`;
  if (diff < 86400) return `${Math.floor(diff / 3600)}h ago`;
  return d.toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' });
}
