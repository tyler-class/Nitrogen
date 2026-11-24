// Live preview for the page editor. The page is stored as markdown (plus Nitrogen's own
// conventions: typed items, [[links]], callouts, #tags) and drawn formatted all the time: the
// marks (#, **, >, list bullets, link addresses) are hidden and the cursor steps over them as one
// character. Callouts, checkboxes, items, images, rules and code blocks read as finished; tables
// are a grid you type into. Mermaid diagrams are the one exception: click one to edit its
// source, with the diagram drawn under it as you type.
import { ensureSyntaxTree, syntaxTree } from '@codemirror/language';
import {
  EditorSelection,
  EditorState,
  Facet,
  RangeSet,
  StateEffect,
  StateField,
  type Extension,
  type Range,
} from '@codemirror/state';
import { Decoration, EditorView, WidgetType, type DecorationSet } from '@codemirror/view';
import {
  DUE_RE,
  extractItems,
  ITEM_LABELS,
  type Item,
  isOverdue,
  nowMoment,
  reminderPast,
  todayKey,
  type ItemType,
} from '@shared/items';
import { slugify, splitTags, WIKILINK_RE } from '@shared/markdown';
import { iconElement } from './Icon';
import { formatDue } from './Markdown';
import { TableWidget } from './tableWidget';

// ------------------------------------------------------------------ config

/** A diagram drawn by React (the page's own Markdown renderer) into the editor. */
export interface BlockEntry {
  id: number;
  el: HTMLElement;
  source: string;
}

/** Hands diagrams to React, which renders them into their elements through portals. */
export class BlockHost {
  private entries = new Map<number, BlockEntry>();
  private listeners = new Set<() => void>();
  private snapshot: BlockEntry[] = [];
  private next = 1;
  add(el: HTMLElement, source: string): number {
    const id = this.next++;
    this.entries.set(id, { id, el, source });
    this.emit();
    return id;
  }
  remove(id: number) {
    if (this.entries.delete(id)) this.emit();
  }
  subscribe = (fn: () => void) => {
    this.listeners.add(fn);
    return () => void this.listeners.delete(fn);
  };
  get = () => this.snapshot;
  private emit() {
    this.snapshot = [...this.entries.values()];
    for (const fn of this.listeners) fn();
  }
}

/** Where a due date sits, for the date picker. */
export interface DueSpot {
  from: number;
  to: number;
  due: string;
  time: string | null;
  type: ItemType;
  rect: DOMRect;
  /** Just added: open the calendar straight away. */
  fresh?: boolean;
}

export interface LiveConfig {
  /** A wikilink target's address, or null when no page has that title. */
  resolve(title: string): { href: string; archived?: boolean } | null;
  /** Follow a link: in the app for /paths, a new tab otherwise. */
  open(href: string): void;
  /** A due date was tapped: open the date picker for it. */
  editDue(view: EditorView, spot: DueSpot): void;
  blocks: BlockHost;
  /** Questions' answer boxes, drawn by React. */
  answers: BlockHost;
}

export const liveConfig = Facet.define<LiveConfig, LiveConfig>({ combine: (v) => v[0]! });

/** Redraw (the page titles that wikilinks resolve against have changed). */
export const refreshLive = StateEffect.define<null>();
/** The editor gained or lost focus (exported for tests; the view sends it itself). */
export const setFocus = StateEffect.define<boolean>();

// ------------------------------------------------------------- list lines

/** A list item's (or typed item's) first line, split into its parts. Offsets are in the line. */
export interface ListLine {
  indent: number;
  /** "-", "*" or "+" for bullets. */
  bullet: string | null;
  /** The number, for ordered lists. */
  num: number | null;
  delim: string;
  /** Where the bullet or number ends, with its space. */
  markEnd: number;
  /** Offset of the "[ ]" checkbox, if any. */
  box: number | null;
  done: boolean;
  type: ItemType | null;
  /** Offset of the item's type word ("todo:"). */
  typeAt: number | null;
  /** Where the text starts (after the bullet, checkbox and type word). */
  content: number;
}

const LIST_RE =
  /^([ \t]*)(?:([-*+])|(\d{1,9})([.)]))([ \t]+|$)(?:(\[([ xX])\])([ \t]+|$))?(?:((todo|question|reminder):)([ \t]|$))?/i;
// After the type word, one space only: the next may belong to a date chip (" due:…").
const ITEM_ONLY_RE = /^([ \t]*)(?:(\[([ xX])\])([ \t]+))?((todo|question|reminder):)([ \t]|$)/i;

export function parseListLine(text: string): ListLine | null {
  const m = LIST_RE.exec(text);
  if (m) {
    const indent = m[1]!.length;
    const markEnd = indent + (m[2] ?? `${m[3]}${m[4]}`).length + m[5]!.length;
    const box = m[6] ? markEnd : null;
    const afterBox = m[6] ? markEnd + m[6].length + m[8]!.length : markEnd;
    const typeAt = m[9] ? afterBox : null;
    const content = m[9] ? afterBox + m[9].length + m[11]!.length : afterBox;
    return {
      indent,
      bullet: m[2] ?? null,
      num: m[3] ? Number(m[3]) : null,
      delim: m[4] ?? '.',
      markEnd,
      box,
      done: /x/i.test(m[7] ?? ''),
      type: m[10] ? (m[10].toLowerCase() as ItemType) : null,
      typeAt,
      content,
    };
  }
  const i = ITEM_ONLY_RE.exec(text);
  if (!i) return null;
  const indent = i[1]!.length;
  const box = i[2] ? indent : null;
  const typeAt = i[2] ? indent + i[2].length + i[4]!.length : indent;
  return {
    indent,
    bullet: null,
    num: null,
    delim: '.',
    markEnd: indent,
    box,
    done: /x/i.test(i[3] ?? ''),
    type: i[6]!.toLowerCase() as ItemType,
    typeAt,
    content: typeAt + i[5]!.length + i[7]!.length,
  };
}

const BULLETS = ['•', '◦', '▪'];
function alpha(n: number): string {
  let s = '';
  for (let k = Math.max(1, n); k > 0; k = Math.floor((k - 1) / 26))
    s = String.fromCharCode(97 + ((k - 1) % 26)) + s;
  return s;
}
function roman(n: number): string {
  const r: [number, string][] = [
    [1000, 'm'],
    [900, 'cm'],
    [500, 'd'],
    [400, 'cd'],
    [100, 'c'],
    [90, 'xc'],
    [50, 'l'],
    [40, 'xl'],
    [10, 'x'],
    [9, 'ix'],
    [5, 'v'],
    [4, 'iv'],
    [1, 'i'],
  ];
  let out = '';
  for (const [v, s] of r)
    while (n >= v) {
      out += s;
      n -= v;
    }
  return out || 'i';
}
/** The marker for a list level: • ◦ ▪ for bullets, 1. a. i. for numbers, repeating. */
export function markerFor(level: number, num: number | null): string {
  const k = (level - 1) % 3;
  if (num === null) return BULLETS[k]!;
  return `${k === 0 ? num : k === 1 ? alpha(num) : roman(num)}.`;
}

// ----------------------------------------------------------------- widgets

/** A list line's start: bullet, number or checkbox in the margin, then an item's type. */
class PrefixWidget extends WidgetType {
  constructor(
    readonly marker: string,
    readonly check: 'open' | 'done' | 'bell' | null,
    readonly kind: ItemType | 'plain',
    readonly label: string | null,
    /** Offset of "[ ]" from the widget's start, or of where "[x] " goes when there's none. */
    readonly boxAt: number,
    readonly hasBox: boolean,
  ) {
    super();
  }
  eq(o: PrefixWidget) {
    return (
      o.marker === this.marker &&
      o.check === this.check &&
      o.kind === this.kind &&
      o.label === this.label &&
      o.boxAt === this.boxAt &&
      o.hasBox === this.hasBox
    );
  }
  toDOM(view: EditorView) {
    const wrap = document.createElement('span');
    wrap.className = 'cm-prefix';
    const slot = document.createElement('span');
    slot.className = 'cm-lm';
    if (this.check === 'bell') {
      const bell = document.createElement('span');
      bell.className = `item-bell cm-bell item-${this.kind}`;
      bell.appendChild(iconElement('bell', 11));
      slot.appendChild(bell);
    } else if (this.check) {
      const b = document.createElement('span');
      b.className = `item-check cm-check item-${this.kind}`;
      b.setAttribute('role', 'checkbox');
      b.setAttribute('aria-checked', String(this.check === 'done'));
      b.setAttribute('aria-label', this.check === 'done' ? 'Reopen' : 'Check off');
      b.addEventListener('mousedown', (e) => {
        e.preventDefault();
        const pos = view.posAtDOM(wrap) + this.boxAt;
        if (this.hasBox) {
          const box = view.state.sliceDoc(pos, pos + 3);
          view.dispatch({
            changes: { from: pos + 1, to: pos + 2, insert: box[1] === ' ' ? 'x' : ' ' },
          });
        } else view.dispatch({ changes: { from: pos, insert: '[x] ' } });
      });
      slot.appendChild(b);
    } else if (BULLETS.includes(this.marker)) {
      // Bullets drawn as shapes (the font's • ◦ ▪ are tiny): dot, ring, square by level.
      const dot = document.createElement('span');
      dot.className = `cm-dot cm-dot-${BULLETS.indexOf(this.marker)}`;
      slot.appendChild(dot);
    } else {
      slot.textContent = this.marker;
      slot.classList.add('cm-num');
    }
    wrap.appendChild(slot);
    if (this.label) {
      const l = document.createElement('span');
      l.className = `item-label item-${this.kind}`;
      l.textContent = this.label;
      wrap.appendChild(l);
    }
    return wrap;
  }
  ignoreEvent(e: Event) {
    return e.type === 'mousedown' && !!(e.target as HTMLElement).closest?.('.cm-check');
  }
}

class TextWidget extends WidgetType {
  constructor(
    readonly text: string,
    readonly cls: string,
  ) {
    super();
  }
  eq(o: TextWidget) {
    return o.text === this.text && o.cls === this.cls;
  }
  toDOM() {
    const s = document.createElement('span');
    s.className = this.cls;
    s.textContent = this.text;
    if (this.cls.includes('cm-hint')) s.setAttribute('aria-hidden', 'true');
    return s;
  }
  ignoreEvent() {
    return false;
  }
}

/** The three kinds of callout. Others written elsewhere show as the nearest of them. */
const CALLOUT_TYPES = ['note', 'tip', 'warning'];
export const CALLOUT_ALIAS: Record<string, string> = {
  important: 'tip',
  caution: 'warning',
  danger: 'warning',
  question: 'note',
  info: 'note',
};
const CALLOUT_ICON: Record<string, string> = {
  note: 'note',
  tip: 'bulb',
  warning: 'warning',
};

/** Closes any open editor menu (callout kinds). */
let closeMenu: (() => void) | null = null;

/**
 * After a link (to a web address, or to a page): a small "open" icon that hangs on the end of the
 * link's text (it never wraps onto a line of its own). A tap opens it: a web address in a new tab,
 * a page in the app.
 */
class LinkOut extends WidgetType {
  constructor(readonly href: string) {
    super();
  }
  eq(o: LinkOut) {
    return o.href === this.href;
  }
  toDOM(view: EditorView) {
    const s = document.createElement('span');
    s.className = 'cm-link-out';
    // A word joiner: no line break between the link's last letter and the icon.
    s.textContent = '\u2060';
    s.appendChild(iconElement('external', 13));
    s.title = 'Open in a new tab';
    s.setAttribute('role', 'link');
    s.setAttribute('aria-label', 'Open in a new tab');
    s.addEventListener('mousedown', (e) => e.preventDefault());
    s.addEventListener('click', (e) => {
      e.preventDefault();
      const href = this.href;
      if (href.startsWith('/') && !href.startsWith('//') && !href.startsWith('/files/'))
        view.state.facet(liveConfig).open(href);
      else window.open(href, '_blank', 'noopener,noreferrer');
    });
    return s;
  }
  ignoreEvent() {
    return true;
  }
}

/** The callout a line belongs to: its "> [!NOTE]" line and its last line (1-based). */
export function calloutAround(
  doc: EditorState['doc'],
  n: number,
): { head: number; last: number } | null {
  const quoted = (k: number) => /^\s*>/.test(doc.line(k).text);
  const header = (k: number) => CALLOUT_RE.test(doc.line(k).text);
  if (!quoted(n)) return null;
  let head = n;
  while (head > 1 && !header(head) && quoted(head - 1)) head--;
  if (!header(head)) return null;
  let last = head;
  while (last < doc.lines && quoted(last + 1) && !header(last + 1)) last++;
  return { head, last };
}

/**
 * Takes a callout away: an empty one goes completely; one with writing in it leaves the writing
 * as plain text. The cursor goes where its text starts.
 */
export function removeCallout(view: EditorView, line: number): boolean {
  const { doc } = view.state;
  const c = calloutAround(doc, line);
  if (!c) return false;
  const head = doc.line(c.head);
  const last = doc.line(c.last);
  const title = CALLOUT_RE.exec(head.text)![5]!.trim();
  let body = '';
  for (let n = c.head + 1; n <= c.last; n++) body += doc.line(n).text.replace(/^\s*>[ \t]?/, '');
  if (!title && !body.trim()) {
    view.dispatch({
      changes: { from: head.from, to: last.to },
      selection: { anchor: head.from },
      userEvent: 'delete',
    });
    return true;
  }
  const lines: string[] = [];
  if (title) lines.push(title);
  for (let n = c.head + 1; n <= c.last; n++)
    lines.push(doc.line(n).text.replace(/^\s*>[ \t]?/, ''));
  view.dispatch({
    changes: { from: head.from, to: last.to, insert: lines.join('\n') },
    selection: EditorSelection.cursor(head.from, 1),
    userEvent: 'delete',
  });
  return true;
}

/**
 * The editors' markdown, without the old way to write a heading (text over a line of "-" or "="):
 * typing "- " to start a list under a line would make that line a heading until you typed more
 * (bold, and in a callout, its title and a stray ">").
 */
export const NO_UNDERLINED_HEADINGS = [{ remove: ['SetextHeading'] }];

/** A link to another page ([[Title]]), drawn as one piece; a click opens the page. */
class PageLink extends WidgetType {
  constructor(
    readonly label: string,
    readonly cls: string,
    readonly href: string | null,
  ) {
    super();
  }
  eq(o: PageLink) {
    return o.label === this.label && o.cls === this.cls && o.href === this.href;
  }
  toDOM(view: EditorView) {
    const a = document.createElement('span');
    a.className = this.cls;
    a.textContent = this.label;
    if (!this.href) a.title = 'No page has this title yet';
    a.addEventListener('mousedown', (e) => {
      if (e.button !== 0) return;
      e.preventDefault();
      if (this.href) view.state.facet(liveConfig).open(this.href);
    });
    return a;
  }
  ignoreEvent(e: Event) {
    return e.type === 'mousedown';
  }
}

/**
 * A question's answer under it, drawn by React (the same answer box as in Action Items) through
 * the answers BlockHost: an Answer button while it's open, then "ANSWER" and the answer.
 */
class AnswerWidget extends WidgetType {
  constructor(
    readonly answer: string,
    readonly level: number,
    /** It stands in for the answer's own lines under the question (not just after it). */
    readonly over: boolean,
  ) {
    super();
  }
  eq(o: AnswerWidget) {
    return o.answer === this.answer && o.level === this.level && o.over === this.over;
  }
  toDOM(view: EditorView) {
    const el = document.createElement('div');
    el.className = 'cm-answer-block';
    el.style.paddingLeft = `calc(${this.level} * 1.6em)`;
    if (this.over) el.dataset.over = '1';
    const host = view.state.facet(liveConfig).answers;
    const id = host.add(el, this.answer);
    (el as HTMLElement & { _release?: () => void })._release = () => host.remove(id);
    return el;
  }
  destroy(dom: HTMLElement) {
    (dom as HTMLElement & { _release?: () => void })._release?.();
  }
  ignoreEvent() {
    return true;
  }
}

/** A callout's icon and name; tap it to change the kind. */
class CalloutLabel extends WidgetType {
  constructor(
    readonly type: string,
    readonly titled: boolean,
  ) {
    super();
  }
  eq(o: CalloutLabel) {
    return o.type === this.type && o.titled === this.titled;
  }
  toDOM(view: EditorView) {
    const s = document.createElement('span');
    s.className = 'cm-callout-label';
    s.appendChild(iconElement(CALLOUT_ICON[this.type] ?? 'info', 18));
    if (!this.titled) {
      const t = document.createElement('span');
      t.className = 'cm-callout-title';
      t.textContent = this.type[0]!.toUpperCase() + this.type.slice(1);
      s.appendChild(t);
    }
    s.title = 'Change the kind of callout';
    s.addEventListener('mousedown', (e) => {
      e.preventDefault();
      closeMenu?.();
      const menu = document.createElement('div');
      menu.className = 'cm-menu';
      menu.setAttribute('role', 'menu');
      const outside = (ev: Event) => {
        if (!menu.contains(ev.target as Node)) closeMenu?.();
      };
      closeMenu = () => {
        menu.remove();
        document.removeEventListener('pointerdown', outside, true);
        closeMenu = null;
      };
      for (const t of CALLOUT_TYPES) {
        const b = document.createElement('button');
        b.type = 'button';
        b.setAttribute('role', 'menuitem');
        b.appendChild(iconElement(CALLOUT_ICON[t]!, 16));
        b.append(t[0]!.toUpperCase() + t.slice(1));
        b.className = `cm-callout-${t}`;
        if (t === this.type) b.classList.add('on');
        b.addEventListener('mousedown', (ev) => {
          ev.preventDefault();
          const line = view.state.doc.lineAt(view.posAtDOM(s));
          const m = /\[!([A-Za-z]+)\]/.exec(line.text);
          if (m) {
            const from = line.from + m.index + 2;
            view.dispatch({ changes: { from, to: from + m[1]!.length, insert: t.toUpperCase() } });
          }
          closeMenu?.();
        });
        menu.appendChild(b);
      }
      const rm = document.createElement('button');
      rm.type = 'button';
      rm.setAttribute('role', 'menuitem');
      rm.className = 'cm-menu-remove';
      rm.appendChild(iconElement('trash', 16));
      rm.append('Remove callout');
      rm.addEventListener('mousedown', (ev) => {
        ev.preventDefault();
        closeMenu?.();
        removeCallout(view, view.state.doc.lineAt(view.posAtDOM(s)).number);
        view.focus();
      });
      menu.appendChild(rm);
      const r = s.getBoundingClientRect();
      menu.style.left = `${Math.max(8, r.left)}px`;
      menu.style.top = `${r.bottom + 6}px`;
      document.body.appendChild(menu);
      setTimeout(() => document.addEventListener('pointerdown', outside, true));
    });
    return s;
  }
  ignoreEvent(e: Event) {
    return e.type === 'mousedown';
  }
}

/** Opens the date picker for the due date starting at `from` (a date just added). */
export function openDueAt(view: EditorView, from: number) {
  requestAnimationFrame(() => {
    for (const el of view.contentDOM.querySelectorAll<HTMLElement>('.cm-due')) {
      if (view.posAtDOM(el) + Number(el.dataset.lead ?? 0) !== from) continue;
      const line = view.state.doc.lineAt(from);
      const m = /^due:\s?(\d{4}-\d{2}-\d{2})(?:(?:T|\s+)(\d{1,2}:\d{2}))?/i.exec(
        view.state.sliceDoc(from, line.to),
      );
      const type = parseListLine(line.text)?.type;
      if (!m || !type) return;
      view.state.facet(liveConfig).editDue(view, {
        from,
        to: from + m[0].length,
        due: m[1]!,
        time: m[2] ?? null,
        type,
        rect: el.getBoundingClientRect(),
        fresh: true,
      });
      return;
    }
  });
}

/** A due date as a chip ("Dec 1"); tap it to change the date. */
class DueWidget extends WidgetType {
  constructor(
    readonly text: string,
    readonly overdue: boolean,
    readonly due: string,
    readonly time: string | null,
    readonly type: ItemType,
    /** Length of "due:…" in the source. */
    readonly length: number,
    /** The space before "due:" is part of the chip (1), so it can't be deleted or typed into. */
    readonly lead: number,
  ) {
    super();
  }
  eq(o: DueWidget) {
    return (
      o.text === this.text &&
      o.overdue === this.overdue &&
      o.due === this.due &&
      o.time === this.time &&
      o.type === this.type &&
      o.length === this.length &&
      o.lead === this.lead
    );
  }
  toDOM(view: EditorView) {
    const s = document.createElement('span');
    s.className = `cm-due${this.overdue ? ' overdue' : ''}${this.lead ? ' spaced' : ''}`;
    s.dataset.lead = String(this.lead);
    s.appendChild(iconElement('calendar', 13));
    s.append(this.text);
    s.addEventListener('mousedown', (e) => {
      e.preventDefault();
      const from = view.posAtDOM(s) + this.lead;
      view.state.facet(liveConfig).editDue(view, {
        from,
        to: from + this.length,
        due: this.due,
        time: this.time,
        type: this.type,
        rect: s.getBoundingClientRect(),
      });
    });
    return s;
  }
  ignoreEvent(e: Event) {
    return e.type === 'mousedown';
  }
}

class RuleWidget extends WidgetType {
  eq() {
    return true;
  }
  toDOM() {
    const s = document.createElement('div');
    s.className = 'cm-hr';
    return s;
  }
}

/** A code block's top: its language, which you can type over. */
class CodeHead extends WidgetType {
  constructor(readonly lang: string) {
    super();
  }
  eq(o: CodeHead) {
    return o.lang === this.lang;
  }
  toDOM(view: EditorView) {
    const d = document.createElement('div');
    d.className = 'cm-code-head';
    const input = document.createElement('input');
    input.className = 'cm-code-lang';
    input.value = this.lang;
    input.placeholder = 'Code';
    input.setAttribute('aria-label', 'Language');
    input.spellcheck = false;
    input.autocapitalize = 'off';
    const commit = () => {
      const line = view.state.doc.lineAt(view.posAtDOM(d));
      const m = /^(\s*(?:```|~~~))(.*)$/.exec(line.text);
      const lang = input.value.trim().replace(/\s+/g, '-');
      if (m && m[2]!.trim() !== lang)
        view.dispatch({ changes: { from: line.from + m[1]!.length, to: line.to, insert: lang } });
    };
    input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' || e.key === 'Escape') {
        e.preventDefault();
        commit();
        const next = view.state.doc.lineAt(view.posAtDOM(d)).to + 1;
        view.focus();
        view.dispatch({ selection: { anchor: Math.min(next, view.state.doc.length) } });
      }
    });
    input.addEventListener('blur', commit);
    d.appendChild(input);
    return d;
  }
  ignoreEvent() {
    return true;
  }
}

class ImageWidget extends WidgetType {
  constructor(
    readonly src: string,
    readonly alt: string,
    readonly width: number | null,
    /** Length of the alt text in the source ("![" + this + "]"). */
    readonly altLength: number,
    /** Drawn as its own line (the picture alone on its line): where its "![" is in the line. */
    readonly lineLead: number | null = null,
  ) {
    super();
  }
  eq(o: ImageWidget) {
    return (
      o.src === this.src &&
      o.alt === this.alt &&
      o.width === this.width &&
      o.altLength === this.altLength &&
      o.lineLead === this.lineLead
    );
  }
  toDOM(view: EditorView) {
    const inner = this.inner(view);
    if (this.lineLead === null) return inner;
    const line = document.createElement('div');
    line.className = 'cm-img-line';
    line.appendChild(inner);
    return line;
  }
  private inner(view: EditorView) {
    const wrap = document.createElement('span');
    wrap.className = 'cm-img';
    const altFrom = () => {
      const at = view.posAtDOM(wrap);
      return (this.lineLead === null ? at : view.state.doc.lineAt(at).from + this.lineLead) + 2;
    };
    if (this.src.startsWith('uploading-')) {
      wrap.classList.add('uploading');
      wrap.textContent = this.alt || 'Uploading…';
      return wrap;
    }
    const img = document.createElement('img');
    img.src = this.src;
    img.alt = this.alt;
    img.decoding = 'async';
    img.draggable = false;
    if (this.width) img.style.width = `${this.width}px`;
    wrap.appendChild(img);
    // Drag the corner to resize; the height follows, so the picture keeps its shape.
    const handle = document.createElement('span');
    handle.className = 'cm-img-handle';
    handle.setAttribute('aria-hidden', 'true');
    handle.addEventListener('pointerdown', (e) => {
      e.preventDefault();
      e.stopPropagation();
      handle.setPointerCapture(e.pointerId);
      const startX = e.clientX;
      const start = img.getBoundingClientRect().width;
      const max = view.contentDOM.getBoundingClientRect().width;
      let w = start;
      wrap.classList.add('resizing');
      const move = (ev: PointerEvent) => {
        w = Math.round(Math.min(max, Math.max(60, start + ev.clientX - startX)));
        img.style.width = `${w}px`;
      };
      const up = () => {
        handle.removeEventListener('pointermove', move);
        handle.removeEventListener('pointerup', up);
        handle.removeEventListener('pointercancel', up);
        wrap.classList.remove('resizing');
        if (Math.abs(w - start) < 2) return;
        const from = altFrom();
        // Full width needs no number.
        const alt = w >= max - 2 ? this.alt : `${this.alt}|${w}`;
        view.dispatch({ changes: { from, to: from + this.altLength, insert: alt } });
      };
      handle.addEventListener('pointermove', move);
      handle.addEventListener('pointerup', up);
      handle.addEventListener('pointercancel', up);
    });
    wrap.appendChild(handle);
    return wrap;
  }
  get estimatedHeight() {
    return 240;
  }
  ignoreEvent(e: Event) {
    return !!(e.target as HTMLElement).closest?.('.cm-img-handle');
  }
}

/** A Mermaid diagram, rendered by React through the BlockHost. */
class DiagramWidget extends WidgetType {
  constructor(readonly source: string) {
    super();
  }
  eq(o: DiagramWidget) {
    return o.source === this.source;
  }
  toDOM(view: EditorView) {
    const el = document.createElement('div');
    el.className = 'cm-block cm-block-mermaid prose';
    el.title = 'Click to edit the diagram';
    const host = view.state.facet(liveConfig).blocks;
    const id = host.add(el, this.source);
    (el as HTMLElement & { _release?: () => void })._release = () => host.remove(id);
    return el;
  }
  destroy(dom: HTMLElement) {
    (dom as HTMLElement & { _release?: () => void })._release?.();
  }
  get estimatedHeight() {
    return 260;
  }
  ignoreEvent() {
    return false;
  }
}

// -------------------------------------------------------------- decorating

const CALLOUT_RE = /^(\s*>[ \t]?)(\[!([A-Za-z]+)\][+-]?)([ \t]*)(.*)$/;
const QUOTE_START = /^\s*>/;
/** "==highlighted==" text (not a markdown node: found by its marks, on one line). */
/** A line with only its hidden start: ">" (one or more), then maybe "#" to "######". */
const EMPTY_LINE_START = /^[ \t]*(?:>[ \t]?)*(?:#{1,6}(?:[ \t]+|$))?$/;
export const HIGHLIGHT_RE = /==(?=[^\s=])(.*?[^\s=])==/g;
const DUE_ALL = new RegExp(DUE_RE.source, 'gi');

/** A link the cursor can sit in: its card offers Open, Edit and Remove. */
export interface LinkSpot {
  from: number;
  to: number;
  kind: 'link' | 'wiki' | 'url' | 'tag';
  href: string | null;
  /** For markdown links: where the label and the address are. */
  labelFrom?: number;
  labelTo?: number;
  urlFrom?: number;
  urlTo?: number;
  /** For markdown links: where the whole "[label](address)" starts and ends. */
  start?: number;
  end?: number;
}

export interface Live {
  focused: boolean;
  decos: DecorationSet;
  /** Hidden marks and drawn pieces: the cursor steps over them in one go. */
  atoms: RangeSet<Decoration>;
  /** Whole-line blocks drawn in place of their source: the cursor never rests on their edges. */
  blocks: [number, number][];
  links: LinkSpot[];
}

const hidden = Decoration.replace({});
/**
 * Hidden marks that open or close a format (the "**" around bold, a link's "[" and "](…)"):
 * Enter, Backspace and Delete step around them rather than split or eat them.
 */
const opener = Decoration.replace({ role: 'open' });
const closer = Decoration.replace({ role: 'close' });
/** The hidden start of a line (a bullet, checkbox, "#", ">"): the cursor never rests before it. */
const prefixMark = Decoration.replace({ role: 'prefix' });
export type MarkRole = 'open' | 'close' | 'prefix';

function build(state: EditorState, focused: boolean): Omit<Live, 'focused'> {
  const doc = state.doc;
  const cfg = state.facet(liveConfig);
  const tree = ensureSyntaxTree(state, doc.length, 40) ?? syntaxTree(state);
  const out: Range<Decoration>[] = [];
  const atoms: Range<Decoration>[] = [];
  const links: LinkSpot[] = [];
  const blocks: [number, number][] = [];
  /** Blocks drawn whole (tables, rules, diagrams): nothing else is drawn inside them. */
  const drawn: [number, number][] = [];
  /** Code: no links, tags or items inside. */
  const raw: [number, number][] = [];
  /** Lines inside code blocks (they keep their blank lines and spacing). */
  const codeLines = new Set<number>();

  const sel = focused ? state.selection.ranges : [];
  const touches = (from: number, to: number) => sel.some((r) => r.from <= to && r.to >= from);
  const hide = (from: number, to: number, role?: MarkRole) => {
    if (to <= from) return;
    const d = (
      role === 'open' ? opener : role === 'close' ? closer : role === 'prefix' ? prefixMark : hidden
    ).range(from, to);
    out.push(d);
    atoms.push(d);
  };
  /**
   * A line's hidden start (bullet, "#", ">"): kept in the line but drawn at no size, with its
   * widget (bullet, checkbox, label) beside it. The cursor still steps over it as one piece, but
   * a line with nothing else in it still has text for the browser to put the cursor after.
   */
  const conceal = (from: number, to: number, widget?: WidgetType) => {
    if (to <= from) return;
    if (widget) out.push(Decoration.widget({ widget, side: -1 }).range(from));
    out.push(Decoration.mark({ class: 'cm-conceal' }).range(from, to));
    atoms.push(prefixMark.range(from, to));
  };
  const swap = (from: number, to: number, widget: WidgetType, role?: MarkRole) => {
    const d = Decoration.replace({ widget, role }).range(from, to);
    out.push(d);
    atoms.push(d);
  };
  const block = (from: number, to: number, widget?: WidgetType) => {
    const d = Decoration.replace({ widget, block: true }).range(from, to);
    out.push(d);
    atoms.push(d);
    blocks.push([from, to]);
  };
  const mark = (from: number, to: number, cls: string, attrs?: Record<string, string>) => {
    if (to > from) out.push(Decoration.mark({ class: cls, attributes: attrs }).range(from, to));
  };
  const lineDeco = (pos: number, cls: string, style?: string) =>
    out.push(
      Decoration.line({ class: cls, attributes: style ? { style } : undefined }).range(
        doc.lineAt(pos).from,
      ),
    );
  const inside = (list: [number, number][], from: number, to: number) =>
    list.some(([a, b]) => from < b && to > a);
  // Questions' answers (which can go on over lines below), parsed once when needed.
  let byLine: Map<number, Item> | null = null;
  const itemsByLine = () =>
    (byLine ??= new Map(extractItems(doc.toString()).map((i) => [i.line, i])));
  const levelAt = (pos: number) => {
    let level = 0;
    for (
      let p: ReturnType<typeof tree.resolveInner> | null = tree.resolveInner(pos, 1);
      p;
      p = p.parent
    )
      if (p.name === 'ListItem') level++;
    return level;
  };

  tree.iterate({
    enter: (node) => {
      const name = node.name;
      if (name.startsWith('ATXHeading')) {
        lineDeco(node.from, `cm-h cm-h${name.slice(-1)}`);
        const m = node.node.firstChild;
        if (m?.name === 'HeaderMark') {
          let end = m.to;
          while (doc.sliceString(end, end + 1) === ' ') end++;
          conceal(m.from, end);
        }
        // A closing "##" run ("## Title ##"), with the space before it.
        const last = node.node.lastChild;
        if (last && m && last.from > m.to && last.name === 'HeaderMark')
          hide(Math.max(m.to, last.from - 1), last.to);
        return;
      }
      // "Text" over a line of "-" or "=" (the old way to write a heading) is left as written:
      // typing "- " under a line would make one for a moment and lose the cursor.
      switch (name) {
        case 'Emphasis':
        case 'StrongEmphasis':
        case 'Strikethrough': {
          for (let c = node.node.firstChild; c; c = c.nextSibling)
            if (c.name === 'EmphasisMark' || c.name === 'StrikethroughMark')
              hide(c.from, c.to, c.from === node.from ? 'open' : 'close');
          return;
        }
        case 'Escape':
          hide(node.from, node.from + 1);
          return;
        case 'InlineCode': {
          raw.push([node.from, node.to]);
          mark(node.from, node.to, 'cm-icode');
          for (let c = node.node.firstChild; c; c = c.nextSibling)
            if (c.name === 'CodeMark') hide(c.from, c.to, c.from === node.from ? 'open' : 'close');
          return false;
        }
        case 'FencedCode':
        case 'CodeBlock': {
          raw.push([node.from, node.to]);
          const first = doc.lineAt(node.from);
          const last = doc.lineAt(node.to);
          const info = node.node.getChild('CodeInfo');
          const lang = info ? doc.sliceString(info.from, info.to).trim() : '';
          const fenced = name === 'FencedCode';
          const closed = fenced && last.number > first.number && /^\s*(```|~~~)/.test(last.text);
          if (lang.toLowerCase() === 'mermaid' && closed) {
            const source = doc.sliceString(first.from, last.to);
            if (!touches(first.from, last.to)) {
              // The one block whose source shows when you click into it.
              const d = Decoration.replace({
                widget: new DiagramWidget(source),
                block: true,
              }).range(first.from, last.to);
              out.push(d);
              atoms.push(d);
              drawn.push([first.from, last.to]);
              return false;
            }
            out.push(
              Decoration.widget({ widget: new DiagramWidget(source), block: true, side: 1 }).range(
                last.to,
              ),
            );
            for (let n = first.number; n <= last.number; n++) {
              codeLines.add(n);
              let cls = 'cm-codeblock cm-mermaid-src';
              if (n === first.number) cls += ' cm-codeblock-first';
              if (n === last.number) cls += ' cm-codeblock-last';
              lineDeco(doc.line(n).from, cls);
            }
            return false;
          }
          // Fences hidden: the language on top, nothing under the last line.
          if (fenced) block(first.from, first.to, new CodeHead(lang));
          if (closed) block(last.from, last.to);
          const top = fenced ? first.number + 1 : first.number;
          const bottom = closed ? last.number - 1 : last.number;
          for (let n = top; n <= bottom; n++) {
            codeLines.add(n);
            let cls = 'cm-codeblock';
            if (n === top && !fenced) cls += ' cm-codeblock-first';
            if (n === bottom) cls += ' cm-codeblock-last';
            lineDeco(doc.line(n).from, cls);
          }
          for (const n of [first.number, last.number]) codeLines.add(n);
          return false;
        }
        case 'Table': {
          const first = doc.lineAt(node.from);
          const last = doc.lineAt(node.to);
          block(first.from, last.to, new TableWidget(doc.sliceString(first.from, last.to)));
          drawn.push([first.from, last.to]);
          return false;
        }
        case 'HorizontalRule': {
          const l = doc.lineAt(node.from);
          block(l.from, l.to, new RuleWidget());
          drawn.push([l.from, l.to]);
          return;
        }
        case 'Blockquote': {
          const first = doc.lineAt(node.from);
          const last = doc.lineAt(node.to);
          // A quote inside a callout (or another quote): its own bar, inside the box.
          if (node.node.parent?.name === 'Blockquote') {
            for (let n = first.number; n <= last.number; n++)
              if (/^\s*>[ \t]?>/.test(doc.line(n).text)) lineDeco(doc.line(n).from, 'cm-quote-in');
            return;
          }
          const c = CALLOUT_RE.exec(first.text);
          const t = c?.[3]!.toLowerCase();
          const type = t ? (CALLOUT_TYPES.includes(t) ? t : (CALLOUT_ALIAS[t] ?? 'note')) : null;
          // Only lines that start with ">" are in the box: a line run on without one is its own.
          const quoted: number[] = [];
          for (let n = first.number; n <= last.number; n++)
            if (/^\s*>/.test(doc.line(n).text)) quoted.push(n);
          quoted.forEach((n, k) => {
            let cls = type ? `cm-callout cm-callout-${type}` : 'cm-quote';
            if (k === 0) cls += ' cm-q-first';
            if (k === quoted.length - 1) cls += ' cm-q-last';
            lineDeco(doc.line(n).from, cls);
          });
          if (c && type) {
            const end = first.from + c[1]!.length + c[2]!.length + c[4]!.length;
            const title = c[5]!.trim();
            conceal(first.from, end, new CalloutLabel(type, !!title));
            if (title) mark(end, first.to, 'cm-callout-title');
          }
          return;
        }
        case 'QuoteMark': {
          const l = doc.lineAt(node.from);
          // A callout's first line is covered by its label.
          if (CALLOUT_RE.test(l.text) && node.from - l.from < 4) return;
          let end = node.to;
          if (doc.sliceString(end, end + 1) === ' ') end++;
          conceal(node.from === l.from ? l.from : node.from, end);
          return;
        }
        case 'Image': {
          const url = node.node.getChild('URL');
          if (!url) return false;
          const src = doc.sliceString(url.from, url.to);
          const rawAlt = /^!\[([^\]]*)\]/.exec(doc.sliceString(node.from, node.to))?.[1] ?? '';
          const sized = /^(.*)\|(\d{2,5})$/.exec(rawAlt);
          const l = doc.lineAt(node.from);
          // A picture alone on its line takes the whole line: text goes above or below it.
          const alone =
            !doc.sliceString(l.from, node.from).trim() &&
            !doc.sliceString(node.to, l.to).trim() &&
            !QUOTE_START.test(l.text);
          const widget = new ImageWidget(
            src,
            sized ? sized[1]! : rawAlt,
            sized ? Number(sized[2]) : null,
            rawAlt.length,
            alone ? node.from - l.from : null,
          );
          if (alone) {
            block(l.from, l.to, widget);
            drawn.push([l.from, l.to]);
          } else swap(node.from, node.to, widget);
          return false;
        }
        case 'Link': {
          const url = node.node.getChild('URL');
          const marks = node.node.getChildren('LinkMark');
          // "[text](address)", or "[text]()" still waiting for its address.
          if (marks.length < 3 || (!url && marks.length < 4)) return;
          const open = marks[0]!;
          const close = marks[1]!;
          const urlFrom = url ? url.from : marks[2]!.to;
          const urlTo = url ? url.to : marks[3]!.from;
          const href = doc.sliceString(urlFrom, urlTo);
          hide(open.from, open.to, 'open');
          mark(open.to, close.from, 'cm-link', { title: href });
          hide(close.from, node.to, 'close');
          if (href.trim())
            out.push(
              Decoration.widget({ widget: new LinkOut(href.trim()), side: -1 }).range(node.to),
            );
          links.push({
            from: open.to,
            to: close.from,
            kind: 'link',
            href,
            labelFrom: open.to,
            labelTo: close.from,
            urlFrom,
            urlTo,
            start: node.from,
            end: node.to,
          });
          return;
        }
        case 'URL': {
          const parent = node.node.parent?.name;
          if (parent === 'Link' || parent === 'Image' || parent === 'LinkReference') return;
          const text = doc.sliceString(node.from, node.to);
          if (!/^(https?:|mailto:|www\.)/i.test(text)) return;
          const href = /^www\./i.test(text) ? `https://${text}` : text;
          if (parent === 'Autolink') {
            hide(node.from - 1, node.from, 'open');
            hide(node.to, node.to + 1, 'close');
          }
          mark(node.from, node.to, 'cm-link');
          out.push(
            Decoration.widget({ widget: new LinkOut(href), side: -1 }).range(
              parent === 'Autolink' ? node.to + 1 : node.to,
            ),
          );
          links.push({ from: node.from, to: node.to, kind: 'url', href });
          return;
        }
      }
      return;
    },
  });

  const head = state.selection.main;
  const cursorLine = focused && head.empty ? doc.lineAt(head.head).number : -1;

  // Line by line: lists and typed items, blank lines, [[wikilinks]] and #tags.
  for (let n = 1; n <= doc.lines; n++) {
    if (codeLines.has(n)) continue;
    const line = doc.line(n);
    if (inside(drawn, line.from, Math.max(line.to, line.from + 1))) continue;
    const text = line.text;
    if (!text.trim()) {
      // A blank line is a whole line, the same height
      // with or without the cursor on it. The cursor's one gets a hint drawn over it.
      if (n === cursorLine && doc.length > 0)
        out.push(
          Decoration.line({
            class: 'cm-blank cm-blank-here',
            attributes: { 'data-hint': 'Type / for blocks, @ to link a page' },
          }).range(line.from),
        );
      // (An empty page keeps a normal line, under its placeholder.)
      else if (doc.length > 0) lineDeco(line.from, 'cm-blank');
      continue;
    }

    // A callout or quote's ">" comes first on a quoted list line ("> - item").
    const q = CALLOUT_RE.test(text) ? null : /^(?:[ \t]*>[ \t]?)+/.exec(text);
    const qLen = q ? q[0].length : 0;
    const L = parseListLine(text.slice(qLen));
    if (L) {
      const base = line.from + qLen;
      const level = Math.max(1, levelAt(base + L.indent));
      const kind = L.type ?? 'plain';
      const check: 'open' | 'done' | 'bell' | null =
        L.type === 'reminder'
          ? 'bell'
          : L.box !== null
            ? L.done
              ? 'done'
              : 'open'
            : L.type
              ? 'open'
              : null;
      conceal(
        base,
        base + L.content,
        new PrefixWidget(
          markerFor(level, L.num),
          check,
          kind,
          L.type ? ITEM_LABELS[L.type] : null,
          L.box ?? L.typeAt ?? 0,
          L.box !== null,
        ),
      );
      lineDeco(
        line.from,
        `cm-li${L.type ? ` cm-item item-${L.type}` : ''}${L.done ? ' cm-done' : ''}`,
        `--lvl:${level}`,
      );
      const content = text.slice(qLen + L.content);
      if (!content.trim() && n === cursorLine)
        out.push(
          Decoration.widget({
            widget: new TextWidget(
              L.type === 'todo'
                ? 'To do'
                : L.type === 'question'
                  ? 'Question'
                  : L.type === 'reminder'
                    ? 'Remind me to…'
                    : 'List',
              'cm-hint',
            ),
            side: 1,
          }).range(line.to),
        );
      if (L.type) {
        const startAt = base + L.content;
        for (const d of content.matchAll(DUE_ALL)) {
          // The space before "due:" goes into the chip with it.
          const lead = /^\s/.test(d[0]) ? 1 : 0;
          const from = startAt + d.index;
          const to = startAt + d.index + d[0].length;
          const due = d[1]!;
          const time = d[2] ?? null;
          const past =
            L.type === 'reminder' &&
            reminderPast({ type: L.type, due, due_time: time }, nowMoment());
          const overdue = !L.done && isOverdue({ type: L.type, due }, todayKey());
          const words = past ? 'Past · ' : overdue ? 'Overdue · ' : '';
          swap(
            from,
            to,
            new DueWidget(
              `${words}${formatDue(due, time)}`,
              overdue,
              due,
              time,
              L.type,
              to - from - lead,
              lead,
            ),
          );
        }
        // A question's answer goes under it, as in Action Items: an Answer button while it's
        // open, then the answer (its " answer: …" on the line, and any lines of it below, hidden).
        if (L.type === 'question') {
          const item = itemsByLine().get(n);
          const ans = /\s+answer:/i.exec(content);
          if (ans) hide(startAt + ans.index, line.to);
          const answer = item?.answer ?? '';
          const below = item?.answer_lines ?? 0;
          if (answer || (!L.done && content.trim())) {
            if (below > 0) {
              const last = doc.line(Math.min(doc.lines, n + below));
              const from = line.to + 1;
              out.push(
                Decoration.replace({
                  widget: new AnswerWidget(answer, level, true),
                  block: true,
                }).range(from, last.to),
              );
              atoms.push(hidden.range(from, last.to));
              blocks.push([from, last.to]);
              drawn.push([from, last.to]);
            } else
              out.push(
                Decoration.widget({
                  widget: new AnswerWidget(answer, level, false),
                  block: true,
                  side: 1,
                }).range(line.to),
              );
          }
        }
      }
    } else {
      // A line carried on inside a list item (indented under it): the item's indent, no marker.
      const ws = /^[ \t]*/.exec(text)![0].length;
      if (ws > 0) {
        const level = levelAt(line.from + ws);
        if (level) {
          conceal(line.from, line.from + ws);
          lineDeco(line.from, 'cm-li cm-li-more', `--lvl:${level}`);
        }
      }
    }

    // ==Highlighted== text: its marks hidden, the text in yellow.
    if (text.includes('==')) {
      for (const h of text.matchAll(HIGHLIGHT_RE)) {
        const from = line.from + h.index;
        const to = from + h[0].length;
        if (inside(raw, from, to)) continue;
        hide(from, from + 2, 'open');
        mark(from + 2, to - 2, 'cm-highlight');
        hide(to - 2, to, 'close');
      }
    }

    if (text.includes('[[')) {
      for (const w of text.matchAll(WIKILINK_RE)) {
        const from = line.from + w.index;
        const to = from + w[0].length;
        if (inside(raw, from, to)) continue;
        const target = w[1]!.trim();
        const heading = w[2]?.trim();
        const page = cfg.resolve(target);
        const href = page ? `${page.href}${heading ? `#h-${slugify(heading)}` : ''}` : null;
        const cls = `cm-link cm-wikilink${page ? (page.archived ? ' archived' : '') : ' missing'}`;
        // One solid piece: the cursor goes before or after it, a click opens it, and Backspace
        // after it takes the whole link.
        const label = w[3]?.trim() || (heading ? `${target} › ${heading}` : target);
        swap(from, to, new PageLink(label, cls, href));
        // The same "open" icon as a web link has, on its end (pages that exist only).
        if (href) out.push(Decoration.widget({ widget: new LinkOut(href), side: -1 }).range(to));
        links.push({ from, to, kind: 'wiki', href });
      }
    }

    if (text.includes('#')) {
      // Wikilinks blanked first, as extractTags does.
      const plain = text.replace(WIKILINK_RE, (s) => ' '.repeat(s.length));
      let pos = line.from;
      for (const part of splitTags(plain)) {
        const len = 'text' in part ? part.text.length : part.raw.length;
        if ('tag' in part && !inside(raw, pos, pos + len)) {
          mark(pos, pos + len, 'cm-tag');
          links.push({
            from: pos,
            to: pos + len,
            kind: 'tag',
            href: `/tags/${encodeURIComponent(part.tag)}`,
          });
        }
        pos += len;
      }
    }
  }

  // The cursor's line with nothing after its hidden start (an empty heading, quote or callout
  // line): something the size of a letter for the cursor to stand beside. Without it the cursor
  // takes the size of the hidden "#" or ">", which is none, and can't be seen.
  if (cursorLine > 0) {
    const line = doc.line(cursorLine);
    const c = CALLOUT_RE.exec(line.text);
    if (
      head.head === line.to &&
      !codeLines.has(cursorLine) &&
      ((c && !c[5]!.trim()) || (!c && EMPTY_LINE_START.test(line.text) && !!line.text.trim()))
    )
      out.push(
        Decoration.widget({
          widget: new TextWidget('\u200b', 'cm-hint cm-caret-anchor'),
          side: 1,
        }).range(line.to),
      );
  }

  // Nothing else drawn inside a block drawn whole.
  const keep = (d: Range<Decoration>) =>
    (d.value.spec as { block?: boolean }).block ||
    !drawn.some(([a, b]) => d.from >= a && d.to <= b && d.from < b);
  return {
    decos: Decoration.set(out.filter(keep), true),
    atoms: RangeSet.of(atoms.filter(keep), true),
    blocks,
    links,
  };
}

export const live = StateField.define<Live>({
  create: (state) => ({ focused: false, ...build(state, false) }),
  update(value, tr) {
    let focused = value.focused;
    let force = false;
    for (const e of tr.effects) {
      if (e.is(setFocus)) focused = e.value;
      if (e.is(refreshLive)) force = true;
    }
    if (
      force ||
      focused !== value.focused ||
      tr.docChanged ||
      tr.selection ||
      syntaxTree(tr.state) !== syntaxTree(tr.startState)
    )
      return { focused, ...build(tr.state, focused) };
    return value;
  },
  provide: (f) => [
    EditorView.decorations.from(f, (v) => v.decos),
    EditorView.atomicRanges.of((view) => view.state.field(f).atoms),
  ],
});

/**
 * The cursor never rests on the edge of a block drawn whole (a table, a rule, a code block's
 * hidden fences): typing there would land in its markdown. It goes on to the line past it, the
 * way it was moving.
 */
const offBlockEdges = EditorState.transactionFilter.of((tr) => {
  if (!tr.selection && !tr.docChanged) return tr;
  const sel = tr.newSelection.main;
  if (!sel.empty) return tr;
  const { blocks } = tr.state.field(live);
  const pos = sel.head;
  const hit = blocks.find(([a, b]) => pos === a || pos === b);
  if (!hit) return tr;
  const [a, b] = hit;
  const len = tr.state.doc.length;
  const up = pos < tr.startState.selection.main.head;
  let to: number | null = null;
  if (up) to = a > 0 ? a - 1 : b < len ? b + 1 : null;
  else to = b < len ? b + 1 : a > 0 ? a - 1 : null;
  if (to === null || to === pos) return tr;
  // Landing on another block's edge (two in a row): keep going.
  const again = blocks.find(([x, y]) => to === x || to === y);
  if (again) to = up ? (again[0] > 0 ? again[0] - 1 : to) : again[1] < len ? again[1] + 1 : to;
  return [tr, { selection: { anchor: to }, sequential: true }];
});

/** Where the hidden start of `line` ends (its bullet, checkbox, "#", ">"), or null if it has none. */
export function prefixEnd(state: EditorState, from: number): number | null {
  const { atoms } = state.field(live);
  let end = from;
  for (let moved = true; moved;) {
    moved = false;
    atoms.between(end, end, (f, t, d) => {
      if (f === end && t > end && (d.spec as { role?: MarkRole }).role === 'prefix') {
        end = t;
        moved = true;
        return false;
      }
    });
  }
  return end > from ? end : null;
}

/**
 * The cursor never rests in front of a line's hidden start (typing there would land before the
 * bullet or "#" and break it): it goes to where the text starts. (← from there goes to the line
 * above: a key binding in editorCommands.)
 */
const offLinePrefix = EditorState.transactionFilter.of((tr) => {
  if (!tr.selection && !tr.docChanged) return tr;
  const sel = tr.newSelection.main;
  if (!sel.empty) return tr;
  const line = tr.state.doc.lineAt(sel.head);
  const end = prefixEnd(tr.state, line.from);
  if (end === null) return tr;
  // Right after the hidden start, the cursor leans on the text after it: leaning back on the
  // hidden marks (drawn at no size) would make it vanish.
  if (sel.head === line.from || (sel.head === end && sel.assoc < 0))
    return [tr, { selection: EditorSelection.cursor(end, 1), sequential: true }];
  return tr;
});

/**
 * The cursor never rests on a callout's top line (its icon and name): it goes on into the
 * callout's text, or, moving up out of it, to the end of the line above the callout.
 */
const offCalloutHeads = EditorState.transactionFilter.of((tr) => {
  if (!tr.selection && !tr.docChanged) return tr;
  const sel = tr.newSelection.main;
  if (!sel.empty) return tr;
  const doc = tr.newDoc;
  const line = doc.lineAt(sel.head);
  if (!CALLOUT_RE.test(line.text)) return tr;
  const up = !tr.docChanged && sel.head < tr.startState.selection.main.head;
  const hasBody = line.number < doc.lines && QUOTE_START.test(doc.line(line.number + 1).text);
  let to: number | null = null;
  if ((up || !hasBody) && line.number > 1) to = doc.line(line.number - 1).to;
  else if (hasBody) {
    const next = doc.line(line.number + 1);
    to = prefixEnd(tr.state, next.from) ?? next.from;
  }
  if (to === null || to === sel.head) return tr;
  return [tr, { selection: EditorSelection.cursor(to, 1), sequential: true }];
});

export function livePreview(config: LiveConfig): Extension {
  return [
    liveConfig.of(config),
    live,
    offBlockEdges,
    offLinePrefix,
    offCalloutHeads,
    EditorView.focusChangeEffect.of((_state, focusing) => setFocus.of(focusing)),
    EditorView.domEventHandlers({
      mousedown(e, view) {
        if (e.button !== 0) return false;
        const t = e.target as HTMLElement;
        // Links inside a drawn diagram: the browser (and React Router) follow them.
        if (t.closest('.cm-block a')) return true;
        // ⌘/Ctrl-click follows a link straight away; a plain click puts the cursor in it.
        if (e.metaKey || e.ctrlKey) {
          const pos = view.posAtCoords({ x: e.clientX, y: e.clientY });
          if (pos === null) return false;
          const spot = view.state.field(live).links.find((l) => pos >= l.from && pos <= l.to);
          if (spot?.href) {
            e.preventDefault();
            config.open(spot.href);
            return true;
          }
        }
        return false;
      },
    }),
  ];
}
