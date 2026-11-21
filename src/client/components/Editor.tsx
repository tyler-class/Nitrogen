// The page editor (CodeMirror 6) with live preview: the markdown is what you edit, drawn
// formatted as you type (see livePreview.ts). "/" opens the block menu, "@" links a page (saved as
// a [[Page title]] link, which assistants and exports read).
// Images pasted, dropped or picked are uploaded to R2 and their markdown is put exactly where the
// cursor (or drop point) was.
import {
  forwardRef,
  useEffect,
  useImperativeHandle,
  useRef,
  useState,
  useSyncExternalStore,
} from 'react';
import { createPortal } from 'react-dom';
import { autocompletion, type CompletionContext } from '@codemirror/autocomplete';
import { defaultKeymap, history, historyKeymap, redo, undo } from '@codemirror/commands';
import { markdown, markdownLanguage } from '@codemirror/lang-markdown';
import { syntaxHighlighting, syntaxTree } from '@codemirror/language';
import { languages } from '@codemirror/language-data';
import { Annotation, EditorState, Prec, Transaction } from '@codemirror/state';
import { drawSelection, EditorView, keymap, placeholder } from '@codemirror/view';
import { pageHref } from '@shared/markdown';
import { uploadImage, errorMessage } from '../lib/api';
import { Icon, iconElement } from './Icon';
import { DatePicker, TimePicker } from './DateTimePicker';
import { highlight } from './editorHighlight';
import {
  blockContext,
  currentLineKind,
  editorCommands,
  formatActive,
  linkCommand,
  setLineKind,
  toggleFormat,
  type Format,
  type LineKind,
} from './editorCommands';
import { editorTooltips } from './editorTooltips';
import { BlockHost, live, livePreview, refreshLive, type DueSpot } from './livePreview';
import { Markdown, type TitleIndex } from './Markdown';
import { AnswerBox } from './ItemParts';
import { setItemAnswer } from '@shared/items';
import { insertBlock, NOT_IN_QUOTE, slashSource } from './slashCommands';
import { readLocal, writeLocal } from '../lib/storage';

const theme = EditorView.theme({
  '&': { fontSize: '16px', color: 'var(--ink)', background: 'transparent' },
  '.cm-scroller': { fontFamily: 'var(--font-ui)', lineHeight: '1.55', overflow: 'visible' },
  '.cm-content': { padding: '4px 0 24px', caretColor: 'var(--ink)', maxWidth: '100%' },
  // drawSelection() hides the native caret and draws its own, black by default.
  '.cm-cursor, .cm-dropCursor': { borderLeft: '2px solid var(--ink)' },
  '.cm-line': { padding: '0' },
  '&.cm-focused': { outline: 'none' },
  '.cm-placeholder': { color: 'var(--faint)' },
  '.cm-selectionBackground, &.cm-focused .cm-selectionBackground, ::selection': {
    background: 'color-mix(in srgb, var(--accent) 25%, transparent) !important',
  },
  '.cm-tooltip': {
    background: 'var(--paper)',
    border: '1px solid var(--hairline)',
    borderRadius: '8px',
    boxShadow: 'var(--shadow)',
  },
  // Link suggestions read like breadcrumbs: app font, emoji, title, then where it lives.
  '.cm-tooltip.cm-tooltip-autocomplete': {
    borderRadius: '12px',
    padding: '4px',
    fontFamily: 'var(--font-ui)',
  },
  '.cm-tooltip.cm-tooltip-autocomplete > ul': {
    fontFamily: 'var(--font-ui)',
    maxHeight: '300px',
    minWidth: '200px',
    maxWidth: 'min(560px, 90vw)',
  },
  '.cm-tooltip.cm-tooltip-autocomplete > ul > li': {
    display: 'flex',
    alignItems: 'center',
    gap: '9px',
    padding: '5px 9px',
    borderRadius: '8px',
    lineHeight: '1.3',
  },
  '.cm-tooltip-autocomplete ul li[aria-selected]': {
    background: 'var(--accent-soft)',
    color: 'var(--ink)',
  },
  '.cm-link-icon': { flex: 'none', width: '1.3em', textAlign: 'center', fontSize: '15px' },
  '.cm-link-icon.plain': { filter: 'grayscale(1)', opacity: '0.55', fontSize: '13px' },
  // "/" commands: a small icon, then the name.
  '.cm-cmd-icon': {
    flex: 'none',
    width: '18px',
    display: 'inline-flex',
    alignItems: 'center',
    justifyContent: 'center',
    color: 'var(--muted)',
    fontSize: '11.5px',
    fontWeight: '700',
    letterSpacing: '-0.02em',
  },
  '.cm-cmd-icon svg': { width: '16px', height: '16px' },
  'li[aria-selected] .cm-cmd-icon': { color: 'var(--accent-ink)' },
  // The "/" menu's section headings: small caps, on the left.
  '.cm-tooltip.cm-tooltip-autocomplete > ul > completion-section': {
    display: 'block',
    padding: '8px 9px 3px',
    border: '0',
    color: 'var(--faint)',
    fontSize: '11px',
    fontWeight: '700',
    letterSpacing: '0.08em',
    textTransform: 'uppercase',
    textAlign: 'left',
  },
  '.cm-tooltip.cm-tooltip-autocomplete > ul > completion-section:first-child': {
    paddingTop: '4px',
  },
  '.cm-completionLabel': {
    fontSize: '14px',
    fontWeight: '500',
    flex: 'none',
    maxWidth: '60%',
    overflow: 'hidden',
    textOverflow: 'ellipsis',
  },
  '.cm-completionMatchedText': { textDecoration: 'none', color: 'var(--accent-ink)' },
  '.cm-completionDetail': {
    marginLeft: 'auto',
    paddingLeft: '12px',
    fontStyle: 'normal',
    fontSize: '12.5px',
    color: 'var(--muted)',
    overflow: 'hidden',
    textOverflow: 'ellipsis',
    whiteSpace: 'nowrap',
    minWidth: '0',
  },
});

/** Marks a change that came from elsewhere (an assistant, a checked-off item): not unsaved. */
const external = Annotation.define<boolean>();

export interface EditorHandle {
  /** Puts the cursor in the text (at the start, or where it last was). */
  focus(at?: 'start'): void;
  /** Opens the file picker and inserts the chosen images at the cursor. */
  pickImages(): void;
  /** Replaces the text with a newer version from the server, keeping the cursor where it can. */
  setDoc(text: string): void;
  /** Scrolls to a 1-based line. */
  scrollToLine(line: number): void;
  /** Where a line's top is on screen now (px from the top of the window), for a smooth scroll. */
  lineTop(line: number): number | null;
}

export interface LinkTarget {
  title: string;
  icon: string | null;
  path: string[];
}

interface Props {
  value: string;
  pageId: string;
  /** Pages offered after "@": title, emoji and where they sit in the tree. */
  links: LinkTarget[];
  /** Title → page, for drawing [[wikilinks]] (and missing ones). */
  titles: TitleIndex;
  onChange(value: string): void;
  onSave(): void;
  onError(message: string): void;
  /** Follow an in-app link. */
  onNavigate(href: string): void;
  /** Called once the editor is ready (to scroll to an anchor). */
  onReady?(): void;
}

/** A placeholder's unique mark while its image uploads. */
function uploadToken() {
  return `uploading-${Math.random().toString(36).slice(2, 10)}`;
}

function isImage(f: File) {
  return /^image\/(png|jpe?g|gif|webp|avif)$/.test(f.type);
}

export const Editor = forwardRef<EditorHandle, Props>(function Editor(props, ref) {
  const hostEl = useRef<HTMLDivElement>(null);
  const [due, setDue] = useState<DueSpot | null>(null);
  // For the phone's format bar: whether you're writing, and a tick to redraw its buttons.
  const [writing, setWriting] = useState<EditorView | null>(null);
  const [, setTick] = useState(0);
  const view = useRef<EditorView | null>(null);
  const fileInput = useRef<HTMLInputElement>(null);
  const [blocks] = useState(() => new BlockHost());
  const shown = useSyncExternalStore(blocks.subscribe, blocks.get);
  const [answers] = useState(() => new BlockHost());
  const answerBoxes = useSyncExternalStore(answers.subscribe, answers.get);

  /** Writes a question's answer (from its box under it) the same way Action Items does. */
  const answerAt = (el: HTMLElement, text: string) => {
    const v = view.current;
    // A box already replaced (its answer just saved) has nothing more to save.
    if (!v || !v.contentDOM.contains(el)) return;
    let pos: number;
    try {
      pos = v.posAtDOM(el);
    } catch {
      return;
    }
    const at = v.state.doc.lineAt(pos).number;
    const line = el.dataset.over ? at - 1 : at;
    const next = setItemAnswer(v.state.doc.toString(), line, text);
    if (next === null) return;
    const cur = v.state.doc.toString();
    let a = 0;
    while (a < cur.length && a < next.length && cur[a] === next[a]) a++;
    let b = 0;
    while (
      b < cur.length - a &&
      b < next.length - a &&
      cur[cur.length - 1 - b] === next[next.length - 1 - b]
    )
      b++;
    v.dispatch({
      changes: { from: a, to: cur.length - b, insert: next.slice(a, next.length - b) },
      userEvent: 'input.answer',
    });
  };
  // Latest props for long-lived CodeMirror callbacks.
  const latest = useRef(props);
  useEffect(() => {
    latest.current = props;
  });

  /** Inserts a placeholder at `pos`, uploads, then swaps the placeholder for the real markdown. */
  async function insertImages(files: File[], pos?: number) {
    const v = view.current;
    if (!v) return;
    for (const file of files.filter(isImage)) {
      const token = uploadToken();
      const placeholderText = `![Uploading ${file.name.replace(/[[\]]/g, '')}…](${token})`;
      const at = pos ?? v.state.selection.main.head;
      const line = v.state.doc.lineAt(at);
      // Images go on their own line.
      const before = at > line.from && line.text.trim() ? '\n\n' : '';
      const after = '\n';
      v.dispatch({
        changes: { from: at, insert: `${before}${placeholderText}${after}` },
        selection: { anchor: at + before.length + placeholderText.length + after.length },
      });
      pos = undefined;
      const swap = (insert: string) => {
        const doc = v.state.doc.toString();
        const i = doc.indexOf(placeholderText);
        if (i >= 0) v.dispatch({ changes: { from: i, to: i + placeholderText.length, insert } });
      };
      try {
        const up = await uploadImage(file, latest.current.pageId);
        swap(up.markdown);
      } catch (e) {
        swap('');
        latest.current.onError(`${file.name}: ${errorMessage(e)}`);
      }
    }
  }
  const insertRef = useRef(insertImages);
  useEffect(() => {
    insertRef.current = insertImages;
  });

  useEffect(() => {
    const wikilinks = (ctx: CompletionContext) => {
      const m = ctx.matchBefore(/\[\[[^\]\n]*$/);
      if (!m) return null;
      return {
        from: m.from + 2,
        options: latest.current.links.map((p, i) => ({
          label: p.title,
          apply: `${p.title}]]`,
          detail: p.path.join(' › '),
          type: 'page',
          icon: p.icon,
          // With nothing typed yet, recently edited pages come first.
          boost: Math.max(-99, -i),
        })),
        validFor: /^[^\]\n]*$/,
      };
    };
    // "@" and a page's name: pick it, and a link to it goes in its place.
    const mentions = (ctx: CompletionContext) => {
      const m = ctx.matchBefore(/(?:^|[\s([])@[^@\n]{0,60}$/);
      if (!m) return null;
      const at = m.from + m.text.indexOf('@');
      const query = ctx.state.sliceDoc(at + 1, ctx.pos);
      if (/^\s|\s\s/.test(query)) return null;
      for (
        let n: ReturnType<ReturnType<typeof syntaxTree>['resolveInner']> | null = syntaxTree(
          ctx.state,
        ).resolveInner(at, -1);
        n;
        n = n.parent
      )
        if (/Code|URL|Link/.test(n.name)) return null;
      return {
        from: at + 1,
        options: latest.current.links.map((p, i) => ({
          label: p.title,
          apply: (view: EditorView, _c: unknown, from: number, to: number) => {
            const link = `[[${p.title}]]`;
            view.dispatch({
              changes: { from: from - 1, to, insert: link },
              selection: { anchor: from - 1 + link.length },
              userEvent: 'input.complete',
            });
          },
          detail: p.path.join(' › '),
          type: 'page',
          icon: p.icon,
          boost: Math.max(-99, -i),
        })),
        validFor: /^[^@\n]*$/,
      };
    };
    const v = new EditorView({
      parent: hostEl.current!,
      state: EditorState.create({
        doc: props.value,
        extensions: [
          history(),
          drawSelection(),
          EditorView.lineWrapping,
          // CodeMirror turns these off by default; in prose they help (iOS autocorrect especially).
          EditorView.contentAttributes.of({
            autocorrect: 'on',
            autocapitalize: 'sentences',
            spellcheck: 'true',
            'aria-label': 'Page text',
          }),
          // Enter, Backspace and Tab come from editorCommands, ahead of the defaults.
          Prec.high(editorCommands()),
          editorTooltips(),
          markdown({ base: markdownLanguage, codeLanguages: languages, addKeymap: false }),
          syntaxHighlighting(highlight),
          theme,
          livePreview({
            blocks,
            answers,
            resolve: (title) => {
              const p = latest.current.titles.get(title.toLowerCase());
              return p ? { href: pageHref(p.id, p.title), archived: p.archived } : null;
            },
            open: (href) => {
              if (href.startsWith('/') && !href.startsWith('//') && !href.startsWith('/files/'))
                latest.current.onNavigate(href);
              else window.open(href, '_blank', 'noopener,noreferrer');
            },
            // The picker takes over: no cursor in the text while it's open.
            editDue: (v, spot) => {
              setDue(spot);
              v.contentDOM.blur();
            },
          }),
          placeholder('Start writing. Type / for blocks, @ to link a page.'),
          autocompletion({
            override: [mentions, wikilinks, slashSource(() => fileInput.current?.click())],
            icons: false,
            addToOptions: [
              {
                position: 20,
                render: (c) => {
                  const el = document.createElement('span');
                  const cmd = (c as { cmd?: string }).cmd;
                  if (cmd) {
                    // "/" commands: headings show H1, H2, H3; the rest an icon.
                    el.className = 'cm-cmd-icon';
                    if (/^h\d$/.test(cmd)) el.textContent = cmd.toUpperCase();
                    else el.appendChild(iconElement(cmd, 16));
                    return el;
                  }
                  // Pages: their emoji (or a page glyph) before each title, like the breadcrumbs.
                  el.className = 'cm-link-icon';
                  const icon = (c as { icon?: string | null }).icon;
                  el.textContent = icon || '📄';
                  if (!icon) el.classList.add('plain');
                  return el;
                },
              },
            ],
          }),
          keymap.of([
            {
              key: 'Mod-s',
              preventDefault: true,
              run: () => {
                latest.current.onSave();
                return true;
              },
            },
            ...defaultKeymap,
            ...historyKeymap,
          ]),
          EditorView.updateListener.of((u) => {
            if (u.docChanged && !u.transactions.some((t) => t.annotation(external)))
              latest.current.onChange(u.state.doc.toString());
            if (u.focusChanged) setWriting(u.view.hasFocus ? u.view : null);
            // Any change, including a format waiting for what you type next.
            if (u.transactions.length) setTick((t) => t + 1);
          }),
          EditorView.domEventHandlers({
            paste(e) {
              const files = [...(e.clipboardData?.files ?? [])].filter(isImage);
              if (!files.length) return false;
              e.preventDefault();
              void insertRef.current(files);
              return true;
            },
            drop(e, view) {
              const files = [...(e.dataTransfer?.files ?? [])].filter(isImage);
              if (!files.length) return false;
              e.preventDefault();
              const pos = view.posAtCoords({ x: e.clientX, y: e.clientY }) ?? undefined;
              void insertRef.current(files, pos);
              return true;
            },
          }),
        ],
      }),
    });
    view.current = v;
    // Room to write under a table, rule or code block that ends the page (not an edit to save).
    const len = v.state.doc.length;
    if (len && v.state.field(live).blocks.some(([, b]) => b === len))
      v.dispatch({ changes: { from: len, insert: '\n' }, annotations: external.of(true) });
    latest.current.onReady?.();
    return () => v.destroy();
    // The editor is created once per page; value changes flow out through onChange.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [props.pageId]);

  // Wikilinks are drawn against the page titles: redraw when they change.
  useEffect(() => {
    view.current?.dispatch({ effects: refreshLive.of(null) });
  }, [props.titles]);

  useImperativeHandle(ref, () => ({
    focus: (at) => {
      const v = view.current;
      if (!v) return;
      if (at === 'start') v.dispatch({ selection: { anchor: 0 } });
      v.focus();
    },
    pickImages: () => fileInput.current?.click(),
    setDoc: (text) => {
      const v = view.current;
      if (!v) return;
      const cur = v.state.doc.toString();
      if (cur === text) return;
      // Only the part that changed, so the cursor and scroll stay put around it.
      let a = 0;
      while (a < cur.length && a < text.length && cur[a] === text[a]) a++;
      let b = 0;
      while (
        b < cur.length - a &&
        b < text.length - a &&
        cur[cur.length - 1 - b] === text[text.length - 1 - b]
      )
        b++;
      v.dispatch({
        changes: { from: a, to: cur.length - b, insert: text.slice(a, text.length - b) },
        annotations: [external.of(true), Transaction.addToHistory.of(false)],
      });
    },
    scrollToLine: (line) => {
      const v = view.current;
      if (!v || line < 1 || line > v.state.doc.lines) return;
      const pos = v.state.doc.line(line).from;
      v.dispatch({ effects: EditorView.scrollIntoView(pos, { y: 'start', yMargin: 80 }) });
    },
    lineTop: (line) => {
      const v = view.current;
      if (!v || line < 1 || line > v.state.doc.lines) return null;
      return v.lineBlockAt(v.state.doc.line(line).from).top + v.documentTop;
    },
  }));

  return (
    <>
      <div ref={hostEl} className={`editor live${writing ? ' writing' : ''}`} />
      {writing && coarse() && (
        <PhoneBar view={writing} pickImages={() => fileInput.current?.click()} />
      )}
      {/* Tables and diagrams, drawn by the same renderer as everywhere else. */}
      {shown.map((b) =>
        createPortal(<Markdown source={b.source} titles={props.titles} noItems />, b.el, b.id),
      )}
      {/* Questions' answers: the same box as in Action Items. */}
      {answerBoxes.map((b) =>
        createPortal(
          <AnswerBox answer={b.source || null} onAnswer={(t) => answerAt(b.el, t)} />,
          b.el,
          b.id,
        ),
      )}
      {due && (
        <DuePop
          spot={due}
          locate={() => {
            const v = view.current;
            if (!v) return null;
            for (const el of v.contentDOM.querySelectorAll<HTMLElement>('.cm-due'))
              if (v.posAtDOM(el) + Number(el.dataset.lead ?? 0) === due.from)
                return el.getBoundingClientRect();
            return null;
          }}
          onClose={(back) => {
            const at = due.to;
            setDue(null);
            // Escape: back to writing, just after the date.
            if (back) {
              const v = view.current;
              v?.focus();
              v?.dispatch({ selection: { anchor: Math.min(at, v.state.doc.length) } });
            }
          }}
          onChange={(date, time) => {
            const v = view.current;
            if (!v) return;
            const text = date ? `due:${date}${time ? ` ${time}` : ''}` : '';
            // No date: the space before it goes too.
            const from =
              !date && v.state.sliceDoc(due.from - 1, due.from) === ' ' ? due.from - 1 : due.from;
            v.dispatch({ changes: { from, to: due.to, insert: text } });
            if (date) setDue({ ...due, due: date, time, to: due.from + text.length, fresh: false });
            else setDue(null);
          }}
        />
      )}
      <input
        ref={fileInput}
        type="file"
        accept="image/png,image/jpeg,image/gif,image/webp,image/avif"
        multiple
        hidden
        onChange={(e) => {
          const files = [...(e.target.files ?? [])];
          e.target.value = '';
          void insertImages(files);
          view.current?.focus();
        }}
      />
    </>
  );
});

/** The date (and time) of an item, changed from its chip in the text. */
function DuePop({
  spot,
  locate,
  onChange,
  onClose,
}: {
  spot: DueSpot;
  /** Where its chip is now (null when it's gone). */
  locate(): DOMRect | null;
  onChange(date: string | null, time: string | null): void;
  /** `back`: closed with Escape, so the cursor goes back into the text. */
  onClose(back?: boolean): void;
}) {
  const box = useRef<HTMLDivElement>(null);
  const [rect, setRect] = useState(spot.rect);
  // It sits under its chip and follows it as the page scrolls (adding a date can scroll the
  // line into view); once the chip is out of sight, it closes.
  useEffect(() => {
    const follow = () => {
      const r = locate();
      if (!r || r.bottom < 0 || r.top > window.innerHeight) onClose();
      else setRect(r);
    };
    window.addEventListener('scroll', follow, { capture: true, passive: true });
    window.addEventListener('resize', follow);
    return () => {
      window.removeEventListener('scroll', follow, { capture: true });
      window.removeEventListener('resize', follow);
    };
  }, [locate, onClose]);
  useEffect(() => {
    const down = (e: PointerEvent) => {
      const t = e.target as HTMLElement;
      // The pickers' own pop-overs sit outside this box.
      if (!box.current?.contains(t) && !t.closest('.dt-pop, .picker-pop')) onClose();
    };
    const key = (e: KeyboardEvent) => {
      // The calendar's own pop-over closes first on Escape; then this one.
      if (e.key === 'Escape' && !document.querySelector('.dt-pop')) onClose(true);
    };
    document.addEventListener('pointerdown', down);
    document.addEventListener('keydown', key);
    return () => {
      document.removeEventListener('pointerdown', down);
      document.removeEventListener('keydown', key);
    };
  }, [onClose]);
  const left = Math.max(8, Math.min(rect.left, window.innerWidth - 300));
  return (
    <div
      ref={box}
      className="due-pop"
      role="dialog"
      aria-label="Date"
      style={{ left, top: rect.bottom + 6 }}
    >
      <DatePicker
        value={spot.due}
        onChange={(d) => onChange(d, spot.time)}
        label={spot.type === 'reminder' ? 'Scheduled for' : 'Due date'}
        startOpen={spot.fresh}
      />
      <TimePicker
        value={spot.time ?? ''}
        onChange={(t) => onChange(spot.due, t || null)}
        label="Time (optional)"
      />
      {spot.type !== 'reminder' && (
        <button type="button" className="btn small clear-due" onClick={() => onChange(null, null)}>
          Clear Due Date
        </button>
      )}
    </div>
  );
}

const coarse = () => window.matchMedia('(pointer: coarse)').matches;

type BarItem =
  | { kind: 'format'; f: Format; label: string; text: string }
  | { kind: 'line'; k: LineKind; label: string; icon?: string; text?: string }
  | { kind: 'block'; block: string; label: string; icon: string }
  | { kind: 'do'; run: (v: EditorView) => boolean; label: string; icon: string; always?: boolean }
  | { kind: 'sep' };

const BAR: BarItem[] = [
  { kind: 'do', run: undo, label: 'Undo', icon: 'undo', always: true },
  { kind: 'do', run: redo, label: 'Redo', icon: 'redo', always: true },
  { kind: 'format', f: 'bold', label: 'Bold', text: 'B' },
  { kind: 'format', f: 'italic', label: 'Italic', text: 'I' },
  { kind: 'format', f: 'strike', label: 'Strikethrough', text: 'S' },
  { kind: 'format', f: 'code', label: 'Code', text: '</>' },
  { kind: 'format', f: 'highlight', label: 'Highlight', text: 'A' },
  { kind: 'do', run: linkCommand, label: 'Link', icon: 'link' },
  { kind: 'sep' },
  { kind: 'line', k: 'h1', label: 'Heading 1', text: 'H1' },
  { kind: 'line', k: 'h2', label: 'Heading 2', text: 'H2' },
  { kind: 'line', k: 'h3', label: 'Heading 3', text: 'H3' },
  { kind: 'sep' },
  { kind: 'line', k: 'todo', label: 'To Do', icon: 'check' },
  { kind: 'line', k: 'question', label: 'Question', icon: 'question' },
  { kind: 'line', k: 'reminder', label: 'Reminder', icon: 'bell' },
  { kind: 'sep' },
  { kind: 'line', k: 'bullet', label: 'Bulleted list', icon: 'list' },
  { kind: 'line', k: 'number', label: 'Numbered list', icon: 'numbered' },
  { kind: 'line', k: 'check', label: 'Task list', icon: 'checkbox' },
  { kind: 'line', k: 'quote', label: 'Quote', icon: 'quote' },
  { kind: 'sep' },
  { kind: 'block', block: 'Note', label: 'Note', icon: 'note' },
  { kind: 'block', block: 'Tip', label: 'Tip', icon: 'bulb' },
  { kind: 'block', block: 'Warning', label: 'Warning', icon: 'warning' },
  { kind: 'sep' },
  { kind: 'block', block: 'Table', label: 'Table', icon: 'table' },
  { kind: 'block', block: 'Code', label: 'Code block', icon: 'code' },
  { kind: 'block', block: 'Diagram', label: 'Diagram', icon: 'graph' },
  { kind: 'block', block: 'Divider', label: 'Divider', icon: 'divider' },
  { kind: 'block', block: 'Link to page', label: 'Link to a page', icon: 'page' },
  { kind: 'block', block: 'Image', label: 'Image', icon: 'image' },
];

/**
 * Phones: a floating pill just above the keyboard while you write, with every format as an icon
 * (it scrolls sideways). The end button folds it down to a small round button, and back; the
 * choice is remembered on the device. Buttons keep the keyboard up (they never take the focus).
 */
function PhoneBar({ view, pickImages }: { view: EditorView; pickImages(): void }) {
  const [folded, setFolded] = useState(() => readLocal('n2.formatbar.folded', false));
  const [bottom, setBottom] = useState(0);
  useEffect(() => {
    const vv = window.visualViewport;
    if (!vv) return;
    // Sit on top of the keyboard: the gap between the visible area and the bottom of the window.
    const place = () => setBottom(Math.max(0, window.innerHeight - vv.height - vv.offsetTop));
    place();
    vv.addEventListener('resize', place);
    vv.addEventListener('scroll', place);
    return () => {
      vv.removeEventListener('resize', place);
      vv.removeEventListener('scroll', place);
    };
  }, []);
  const fold = (on: boolean) => {
    setFolded(on);
    writeLocal('n2.formatbar.folded', on);
  };
  const keep = (e: React.PointerEvent | React.MouseEvent) => e.preventDefault();
  const line = currentLineKind(view.state);
  const where = blockContext(view.state, view.state.selection.main.head);
  // In code only undo and redo; in a quote or callout, no blocks it can't hold.
  const blocked = (item: BarItem) =>
    item.kind !== 'sep' &&
    !(item.kind === 'do' && item.always) &&
    (where === 'code' ||
      (where === 'quote' && item.kind === 'block' && NOT_IN_QUOTE.includes(item.block)));
  const run = (item: BarItem) => {
    if (item.kind === 'sep' || blocked(item)) return;
    if (item.kind === 'format') toggleFormat(view, item.f);
    else if (item.kind === 'line') setLineKind(view, item.k);
    else if (item.kind === 'block') insertBlock(view, item.block, pickImages);
    else item.run(view);
  };
  return createPortal(
    <div
      className={`phone-bar${folded ? ' folded' : ''}`}
      style={{ bottom: bottom + 10 }}
      role="toolbar"
      aria-label="Format"
      onPointerDown={keep}
      onMouseDown={keep}
    >
      {/* Always there: folding slides the pill in over it (it fades out, and can't be used). */}
      {
        <div className="phone-bar-scroll" inert={folded} aria-hidden={folded || undefined}>
          {BAR.map((item, n) => {
            if (item.kind === 'sep') return <span key={`sep${n}`} className="pb-sep" aria-hidden />;
            const off = blocked(item);
            const on =
              item.kind === 'format'
                ? formatActive(view.state, item.f)
                : item.kind === 'line' && line === item.k;
            return (
              <button
                key={item.label}
                type="button"
                className={on ? 'on' : undefined}
                disabled={off}
                aria-label={item.label}
                aria-pressed={item.kind === 'format' || item.kind === 'line' ? on : undefined}
                title={item.label}
                onClick={() => run(item)}
              >
                {'icon' in item && item.icon ? (
                  <Icon name={item.icon} size={19} />
                ) : (
                  <span className={`pb-text pb-${item.kind === 'format' ? item.f : 'h'}`}>
                    {'text' in item ? item.text : ''}
                  </span>
                )}
              </button>
            );
          })}
        </div>
      }
      <button
        type="button"
        className="phone-bar-fold"
        aria-label={folded ? 'Show formatting' : 'Hide formatting'}
        aria-expanded={!folded}
        onClick={() => fold(!folded)}
      >
        <Icon name={folded ? 'format' : 'chevron'} size={19} />
      </button>
    </div>,
    document.body,
  );
}
