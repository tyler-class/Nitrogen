// How typing behaves in the page editor: Enter, Backspace and Tab in lists, items and quotes;
// formatting shortcuts that wrap the selection, or hold the format for what you type next;
// pasting a link over text; and the small helpers that keep the markdown tidy underneath.
import { syntaxTree } from '@codemirror/language';
import {
  EditorSelection,
  EditorState,
  StateEffect,
  StateField,
  type ChangeSpec,
  type Extension,
} from '@codemirror/state';
import { EditorView, keymap, type KeyBinding } from '@codemirror/view';
import { indentLess, indentMore, insertNewlineAndIndent } from '@codemirror/commands';
import {
  HIGHLIGHT_RE,
  live,
  parseListLine,
  prefixEnd,
  type ListLine,
  type MarkRole,
} from './livePreview';

// ------------------------------------------------------------------ helpers

const QUOTE_RE = /^(?:[ \t]*>[ \t]?)+/;
const CALLOUT_RE = /^\s*>[ \t]?\[![A-Za-z]+\]/;

function inCode(state: EditorState, pos: number): boolean {
  for (
    let n: ReturnType<ReturnType<typeof syntaxTree>['resolveInner']> | null = syntaxTree(
      state,
    ).resolveInner(pos, -1);
    n;
    n = n.parent
  )
    if (n.name === 'FencedCode' || n.name === 'CodeBlock') return true;
  return false;
}

interface LineInfo {
  from: number;
  text: string;
  /** "> " quoting before the list marker. */
  quote: string;
  list: ListLine | null;
}

function lineInfo(state: EditorState, pos: number): LineInfo {
  const line = state.doc.lineAt(pos);
  const callout = CALLOUT_RE.test(line.text);
  const quote = callout ? '' : (QUOTE_RE.exec(line.text)?.[0] ?? '');
  return {
    from: line.from,
    text: line.text,
    quote,
    list: callout ? null : parseListLine(line.text.slice(quote.length)),
  };
}

/** The prefix a new line in this list gets (the same kind, unchecked, numbered on). */
function nextPrefix(L: ListLine): string {
  const indent = ' '.repeat(L.indent);
  const mark = L.bullet ? `${L.bullet} ` : L.num !== null ? `${L.num + 1}${L.delim} ` : '';
  if (L.type === 'todo') return `${indent}${mark}${L.box !== null || mark ? '[ ] ' : ''}todo: `;
  if (L.type) return '';
  return `${indent}${mark}${L.box !== null ? '[ ] ' : ''}`;
}

/**
 * What the cursor is inside: code (no blocks or formatting), or a quote or callout (text, lists
 * and items only: no tables, code, rules or other callouts and quotes).
 */
export function blockContext(state: EditorState, pos: number): 'code' | 'quote' | null {
  for (
    let n: ReturnType<ReturnType<typeof syntaxTree>['resolveInner']> | null = syntaxTree(
      state,
    ).resolveInner(pos, -1);
    n;
    n = n.parent
  ) {
    if (n.name === 'FencedCode' || n.name === 'CodeBlock' || n.name === 'InlineCode') return 'code';
    if (n.name === 'Blockquote') return 'quote';
  }
  // A quoted line the parser hasn't reached yet, or an empty "> " line.
  return /^\s*>/.test(state.doc.lineAt(pos).text) ? 'quote' : null;
}

// --------------------------------------------------------------- indenting

/** Indents (or outdents) a list item with everything under it. */
function shiftItem(view: EditorView, out: boolean): boolean {
  const { state } = view;
  const sel = state.selection.main;
  const info = lineInfo(state, sel.head);
  const L = info.list;
  if (!L || (L.bullet === null && L.num === null)) return false;
  const doc = state.doc;
  const line = doc.lineAt(sel.head);
  const q = info.quote.length;
  const indentOf = (t: string) => /^[ \t]*/.exec(t.slice(q))![0].length;
  const old = L.indent;
  let target: number;
  let renumber: number | null = null;
  if (!out) {
    // Under the item above at the same level: its text's column.
    let sib: ListLine | null = null;
    for (let n = line.number - 1; n >= 1; n--) {
      const t = doc.line(n).text;
      if (!t.trim()) break;
      const l = parseListLine(t.slice(q));
      const ind = indentOf(t);
      if (l && ind === old && (l.bullet !== null || l.num !== null)) {
        sib = l;
        break;
      }
      if (ind < old || (!l && ind <= old)) break;
    }
    if (!sib) return true;
    target = sib.markEnd;
    // A new sublist of numbers starts at 1.
    if (L.num !== null) {
      let first = true;
      for (let n = line.number - 1; n >= 1; n--) {
        const t = doc.line(n).text;
        const ind = indentOf(t);
        if (ind <= old) break;
        if (ind === target && parseListLine(t.slice(q))?.num !== null) first = false;
      }
      if (first) renumber = 1;
    }
  } else {
    if (old === 0) return true;
    // Back to the parent item's column.
    let parent: ListLine | null = null;
    for (let n = line.number - 1; n >= 1; n--) {
      const t = doc.line(n).text;
      const l = parseListLine(t.slice(q));
      if (l && indentOf(t) < old) {
        parent = l;
        break;
      }
    }
    target = parent ? parent.indent : 0;
    if (L.num !== null && parent?.num != null) renumber = parent.num + 1;
  }
  const delta = target - old;
  const changes: ChangeSpec[] = [];
  const shift = (n: number) => {
    const l = doc.line(n);
    const ind = indentOf(l.text);
    if (delta > 0) changes.push({ from: l.from + q, insert: ' '.repeat(delta) });
    else changes.push({ from: l.from + q, to: l.from + q + Math.min(ind, -delta) });
  };
  shift(line.number);
  // Its own lines and sub-items come along.
  for (let n = line.number + 1; n <= doc.lines; n++) {
    const t = doc.line(n).text;
    if (!t.trim() || indentOf(t) <= old) break;
    shift(n);
  }
  if (renumber !== null && L.num !== null) {
    const at = line.from + q + L.indent;
    changes.push({ from: at, to: at + String(L.num).length, insert: String(renumber) });
  }
  view.dispatch({ changes, userEvent: out ? 'delete.dedent' : 'input.indent' });
  return true;
}

// ------------------------------------------------------------------- Enter

/**
 * Past a run of hidden opening or closing marks (role "open" or "close") from `pos`, forwards
 * (dir 1) or backwards (dir -1). Returns `pos` when there are none.
 */
function pastMarks(state: EditorState, pos: number, dir: 1 | -1, role: MarkRole): number {
  const { atoms } = state.field(live);
  let p = pos;
  for (let moved = true; moved;) {
    moved = false;
    atoms.between(Math.max(0, p - 1), Math.min(state.doc.length, p + 1), (f, t, d) => {
      if ((d.spec as { role?: MarkRole }).role !== role) return;
      if (dir === 1 && f === p && t > p) {
        p = t;
        moved = true;
        return false;
      }
      if (dir === -1 && t === p && f < p) {
        p = f;
        moved = true;
        return false;
      }
    });
  }
  return p;
}

/**
 * Where a line break goes for the cursor at `pos`: never between formatted text and its hidden
 * marks. At the end of bold (before its closing "**"), after the marks; at its start, before.
 */
function breakPoint(state: EditorState, pos: number): number {
  const after = pastMarks(state, pos, 1, 'close');
  if (after !== pos) return after;
  return pastMarks(state, pos, -1, 'open');
}

/** A new line the way Enter makes one in the page (lists carry on): Shift+Enter in an answer. */
export const newLine = (view: EditorView) => enter(view);

function enter(view: EditorView): boolean {
  const { state } = view;
  const sel = state.selection.main;
  if (!sel.empty) return false;
  const pos = breakPoint(state, sel.head);
  const line = state.doc.lineAt(pos);

  // "```js" then Enter at the end of the line: a code block, closed, with the cursor inside.
  const fence = /^(\s*)(```|~~~)([\w+#-]*)\s*$/.exec(line.text);
  if (fence && pos === line.to) {
    let above = 0;
    for (let n = 1; n < line.number; n++) if (/^\s*(```|~~~)/.test(state.doc.line(n).text)) above++;
    if (above % 2 === 0) {
      view.dispatch({
        changes: { from: pos, insert: `\n${fence[1]}\n${fence[1]}${fence[2]}` },
        selection: { anchor: pos + 1 + fence[1]!.length },
        userEvent: 'input',
      });
      return true;
    }
  }

  if (inCode(state, pos)) {
    // Two blank lines at the end of a code block step out of it.
    const prev = line.number > 1 ? state.doc.line(line.number - 1) : null;
    const next = line.number < state.doc.lines ? state.doc.line(line.number + 1) : null;
    if (
      !line.text.trim() &&
      prev &&
      !prev.text.trim() &&
      next &&
      /^\s*(```|~~~)\s*$/.test(next.text)
    ) {
      const cut = line.to - (prev.from - 1);
      const fenceEnd = next.to - cut;
      const last = next.number === state.doc.lines;
      view.dispatch({
        changes: [
          { from: prev.from - 1, to: line.to },
          ...(last ? [{ from: next.to, insert: '\n' }] : []),
        ],
        selection: { anchor: fenceEnd + 1 },
        userEvent: 'input',
      });
      return true;
    }
    return insertNewlineAndIndent(view);
  }
  const info = lineInfo(state, pos);

  const L = info.list;
  if (L) {
    const start = info.from + info.quote.length + L.content;
    const content = info.text.slice(info.quote.length + L.content);
    if (!content.trim()) {
      // An empty item: out a level, or out of the list, onto a clean line.
      if (L.indent > 0 && (L.bullet !== null || L.num !== null)) return shiftItem(view, true);
      view.dispatch({
        changes: { from: info.from + info.quote.length, to: line.to },
        selection: { anchor: info.from + info.quote.length },
        userEvent: 'delete',
      });
      return true;
    }
    const at = Math.max(pos, start);
    const prefix = info.quote + nextPrefix(L);
    const rest = state.sliceDoc(at, line.to);
    view.dispatch({
      changes: { from: at, to: line.to, insert: `\n${prefix}${rest.replace(/^[ \t]+/, '')}` },
      selection: { anchor: at + 1 + prefix.length },
      scrollIntoView: true,
      userEvent: 'input',
    });
    return true;
  }

  if (info.quote || CALLOUT_RE.test(line.text)) {
    const quote = info.quote || (/^\s*>[ \t]?/.exec(line.text)?.[0] ?? '> ');
    const content = CALLOUT_RE.test(line.text) ? 'title' : line.text.slice(quote.length);
    if (!content.trim()) {
      // An empty quoted line: out of the quote.
      view.dispatch({
        changes: { from: line.from, to: line.to },
        selection: { anchor: line.from },
        userEvent: 'delete',
      });
      return true;
    }
    const rest = state.sliceDoc(pos, line.to);
    const q = quote.endsWith(' ') ? quote : `${quote} `;
    view.dispatch({
      changes: { from: pos, to: line.to, insert: `\n${q}${rest.replace(/^[ \t]+/, '')}` },
      selection: { anchor: pos + 1 + q.length },
      scrollIntoView: true,
      userEvent: 'input',
    });
    return true;
  }

  view.dispatch({
    changes: { from: pos, insert: '\n' },
    selection: { anchor: pos + 1 },
    scrollIntoView: true,
    userEvent: 'input',
  });
  return true;
}

/** Shift-Enter: a new line inside the same item or quote, with no new bullet. */
function softBreak(view: EditorView): boolean {
  const { state } = view;
  const sel = state.selection.main;
  if (inCode(state, sel.head)) return insertNewlineAndIndent(view);
  const info = lineInfo(state, sel.head);
  const pad = info.list ? ' '.repeat(info.list.content) : '';
  const insert = `\n${info.quote}${pad}`;
  const at = sel.empty ? breakPoint(state, sel.head) : sel.from;
  view.dispatch({
    changes: { from: at, to: sel.empty ? at : sel.to, insert },
    selection: { anchor: at + insert.length },
    scrollIntoView: true,
    userEvent: 'input',
  });
  return true;
}

// --------------------------------------------------------------- Backspace

function backspace(view: EditorView): boolean {
  const { state } = view;
  const sel = state.selection.main;
  if (!sel.empty) return false;
  const pos = sel.head;
  if (inCode(state, pos)) return false;
  const info = lineInfo(state, pos);
  const line = state.doc.lineAt(pos);
  const L = info.list;
  if (L && pos === info.from + info.quote.length + L.content) {
    // At the start of an item's text: out a level first, then back to plain text.
    if (L.indent > 0 && (L.bullet !== null || L.num !== null)) return shiftItem(view, true);
    const from = info.from + info.quote.length;
    view.dispatch({
      changes: { from, to: pos },
      selection: { anchor: from },
      userEvent: 'delete',
    });
    return true;
  }
  const quote = info.quote;
  if (quote && pos === line.from + quote.length) {
    view.dispatch({ changes: { from: line.from, to: pos }, userEvent: 'delete' });
    return true;
  }
  // Right after formatted text (its closing marks hidden): the last letter goes, not the marks.
  // If that was its only letter, the marks go with it.
  const closeFrom = pastMarks(state, pos, -1, 'close');
  if (closeFrom !== pos && closeFrom > line.from) {
    const openFrom = pastMarks(state, closeFrom - 1, -1, 'open');
    const range =
      openFrom !== closeFrom - 1
        ? { from: openFrom, to: pos }
        : { from: closeFrom - 1, to: closeFrom };
    view.dispatch({ changes: range, userEvent: 'delete.backward' });
    return true;
  }
  // At the start of formatted text: the letter before it goes, not its opening marks.
  const openFrom = pastMarks(state, pos, -1, 'open');
  if (openFrom !== pos) {
    if (openFrom <= line.from) return false;
    view.dispatch({
      changes: { from: openFrom - 1, to: openFrom },
      selection: { anchor: pos - 1 },
      userEvent: 'delete.backward',
    });
    return true;
  }
  // At the start of a line right under a table, rule or code block: don't merge into it.
  if (pos === line.from && line.number > 1) {
    const { blocks } = state.field(live);
    if (blocks.some(([, b]) => b === line.from - 1)) {
      if (!line.text.trim())
        view.dispatch({ changes: { from: line.from - 1, to: line.to }, userEvent: 'delete' });
      return true;
    }
  }
  return false;
}

/** Delete (forwards): the same, the other way round. */
function deleteForward(view: EditorView): boolean {
  const { state } = view;
  const sel = state.selection.main;
  if (!sel.empty || inCode(state, sel.head)) return false;
  const pos = sel.head;
  // At the end of a line, before a list item, heading or quote: joining the lines takes the next
  // one's text, not its hidden bullet or "#".
  const here = state.doc.lineAt(pos);
  if (pos === here.to && here.number < state.doc.lines) {
    const next = state.doc.line(here.number + 1);
    const end = prefixEnd(state, next.from);
    if (end !== null) {
      view.dispatch({ changes: { from: pos, to: end }, userEvent: 'delete.forward' });
      return true;
    }
  }
  // Just before formatted text: its first letter goes (and its marks, if that was the only one).
  const openTo = pastMarks(state, pos, 1, 'open');
  if (openTo !== pos) {
    const closeTo = pastMarks(state, openTo + 1, 1, 'close');
    view.dispatch({
      changes:
        closeTo !== openTo + 1 ? { from: pos, to: closeTo } : { from: openTo, to: openTo + 1 },
      userEvent: 'delete.forward',
    });
    return true;
  }
  // At the end of formatted text: what comes after its closing marks goes.
  const closeTo = pastMarks(state, pos, 1, 'close');
  if (closeTo !== pos) {
    if (closeTo < state.doc.length)
      view.dispatch({
        changes: { from: closeTo, to: closeTo + 1 },
        selection: { anchor: pos },
        userEvent: 'delete.forward',
      });
    return true;
  }
  return false;
}

// -------------------------------------------------------------- formatting

export type Format = 'bold' | 'italic' | 'strike' | 'code' | 'highlight';
const MARK: Record<Format, string> = {
  bold: '**',
  italic: '*',
  strike: '~~',
  code: '`',
  highlight: '==',
};
const NODE: Record<Format, string> = {
  bold: 'StrongEmphasis',
  italic: 'Emphasis',
  strike: 'Strikethrough',
  code: 'InlineCode',
  highlight: '',
};

/** Formats waiting for the next thing typed (⌘B with nothing selected). */
export const setPending = StateEffect.define<Format[]>();
export const pending = StateField.define<Format[]>({
  create: () => [],
  update(value, tr) {
    for (const e of tr.effects) if (e.is(setPending)) return e.value;
    if (tr.docChanged || tr.selection) return value.length ? [] : value;
    return value;
  },
});

/** The formatted span around a position, if any. */
function enclosing(
  state: EditorState,
  from: number,
  to: number,
  f: Format,
): { from: number; to: number } | null {
  if (f === 'highlight') {
    const line = state.doc.lineAt(from);
    if (to > line.to) return null;
    for (const m of line.text.matchAll(HIGHLIGHT_RE)) {
      const a = line.from + m.index;
      const b = a + m[0].length;
      if (a <= from && b >= to) return { from: a, to: b };
    }
    return null;
  }
  for (
    let n: ReturnType<ReturnType<typeof syntaxTree>['resolveInner']> | null = syntaxTree(
      state,
    ).resolveInner(from, 1);
    n;
    n = n.parent
  ) {
    if (n.name === NODE[f] && n.from <= from && n.to >= to) return n;
  }
  for (
    let n: ReturnType<ReturnType<typeof syntaxTree>['resolveInner']> | null = syntaxTree(
      state,
    ).resolveInner(from, -1);
    n;
    n = n.parent
  ) {
    if (n.name === NODE[f] && n.from <= from && n.to >= to) return n;
  }
  return null;
}

/** Is this format on at the cursor (or across the selection)? */
export function formatActive(state: EditorState, f: Format): boolean {
  const { from, to } = state.selection.main;
  if (state.field(pending).includes(f)) return true;
  const n = enclosing(state, from, to, f);
  return !!n && from >= n.from + MARK[f].length && to <= n.to - MARK[f].length;
}

export function toggleFormat(view: EditorView, f: Format): boolean {
  const { state } = view;
  const sel = state.selection.main;
  const m = MARK[f];
  const n = enclosing(state, sel.from, sel.to, f);
  if (sel.empty) {
    // At the end of formatted text: step out of it, so what comes next is plain.
    if (n && sel.head >= n.to - m.length && sel.head <= n.to) {
      view.dispatch({ selection: { anchor: n.to } });
      return true;
    }
    const cur = state.field(pending);
    view.dispatch({
      effects: setPending.of(cur.includes(f) ? cur.filter((x) => x !== f) : [...cur, f]),
    });
    return true;
  }
  if (n) {
    // Already formatted: take the marks off.
    const open = n.from;
    const close = n.to - m.length;
    view.dispatch({
      changes: [
        { from: open, to: open + m.length },
        { from: close, to: n.to },
      ],
      selection: { anchor: sel.from - m.length, head: sel.to - m.length },
      userEvent: 'format',
    });
    return true;
  }
  // Keep the spaces at the edges outside the marks ("**word** " not "**word **").
  const text = state.sliceDoc(sel.from, sel.to);
  const lead = /^\s*/.exec(text)![0].length;
  const trail = /\s*$/.exec(text)![0].length;
  const from = sel.from + lead;
  const to = sel.to - trail;
  if (to <= from) return true;
  view.dispatch({
    changes: [
      { from, insert: m },
      { from: to, insert: m },
    ],
    selection: EditorSelection.range(from + m.length, to + m.length),
    userEvent: 'format',
  });
  return true;
}

/** The next character typed takes the waiting formats. */
const typeWithPending = EditorView.inputHandler.of((view, from, to, text) => {
  const waiting = view.state.field(pending);
  if (!waiting.length || text.includes('\n')) return false;
  // A space goes in plain and the formats keep waiting ("** bold**" wouldn't be bold).
  if (!text.trim()) {
    view.dispatch({
      changes: { from, to, insert: text },
      selection: { anchor: from + text.length },
      effects: setPending.of(waiting),
      userEvent: 'input.type',
    });
    return true;
  }
  const open = waiting.map((f) => MARK[f]).join('');
  const close = [...waiting]
    .reverse()
    .map((f) => MARK[f])
    .join('');
  view.dispatch({
    changes: { from, to, insert: `${open}${text}${close}` },
    selection: { anchor: from + open.length + text.length },
    effects: setPending.of([]),
    userEvent: 'input.type',
  });
  return true;
});

// ------------------------------------------------------------- line kinds

export type LineKind =
  'h1' | 'h2' | 'h3' | 'bullet' | 'number' | 'check' | 'todo' | 'question' | 'reminder' | 'quote';

const LINE_PREFIX: Record<LineKind, string> = {
  h1: '# ',
  h2: '## ',
  h3: '### ',
  bullet: '- ',
  number: '1. ',
  check: '- [ ] ',
  todo: '- [ ] todo: ',
  question: '- question: ',
  reminder: '- reminder: ',
  quote: '> ',
};

/** What kind of line this is, and how long its prefix is. */
function lineKind(text: string): { kind: LineKind | null; indent: string; prefix: number } {
  const h = /^(#{1,3})\s+/.exec(text);
  if (h) return { kind: `h${h[1]!.length}` as LineKind, indent: '', prefix: h[0].length };
  const q = /^>\s?/.exec(text);
  if (q && !CALLOUT_RE.test(text)) return { kind: 'quote', indent: '', prefix: q[0].length };
  const L = parseListLine(text);
  if (!L) return { kind: null, indent: '', prefix: 0 };
  const indent = text.slice(0, L.indent);
  const kind: LineKind = L.type
    ? L.type
    : L.box !== null
      ? 'check'
      : L.num !== null
        ? 'number'
        : 'bullet';
  return { kind, indent, prefix: L.content };
}

/**
 * Makes the cursor's line a heading, list item, checkbox, item or quote (the phone's format bar);
 * the same kind again turns it back into plain text. The text and the cursor stay put.
 */
export function setLineKind(view: EditorView, kind: LineKind): boolean {
  const { state } = view;
  const head = state.selection.main.head;
  if (inCode(state, head)) return false;
  const line = state.doc.lineAt(head);
  const cur = lineKind(line.text);
  const off = cur.kind === kind;
  const lists = ['bullet', 'number', 'check', 'todo', 'question', 'reminder'];
  // A list item keeps its indent when it becomes another kind of item.
  const indent =
    !off && lists.includes(kind) && cur.kind && lists.includes(cur.kind) ? cur.indent : '';
  const prefix = off ? '' : indent + LINE_PREFIX[kind];
  let tail = '';
  if (!off && kind === 'reminder' && !/\sdue:/.test(line.text)) {
    const d = new Date(Date.now() + 7 * 86_400_000);
    tail = ` due:${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  }
  const rel = Math.max(0, head - line.from - cur.prefix);
  const body = line.text.slice(cur.prefix).replace(/\s+$/, '');
  view.dispatch({
    changes: { from: line.from, to: line.to, insert: prefix + body + tail },
    selection: { anchor: line.from + prefix.length + Math.min(rel, body.length) },
    userEvent: 'input.format',
  });
  return true;
}

/** The cursor's line kind, for the format bar's highlighted buttons. */
export function currentLineKind(state: EditorState): LineKind | null {
  return lineKind(state.doc.lineAt(state.selection.main.head).text).kind;
}

// ------------------------------------------------------------------- links

/** Asks the link card to open in edit mode (⌘K). */
export const editLink = StateEffect.define<number | null>();

function linkCommand(view: EditorView): boolean {
  const { state } = view;
  const sel = state.selection.main;
  const spot = state
    .field(live)
    .links.find((l) => l.kind === 'link' && sel.from >= l.from && sel.to <= l.to);
  if (spot) {
    view.dispatch({ effects: editLink.of(spot.from) });
    return true;
  }
  let { from, to } = sel;
  if (from === to) {
    const word = state.wordAt(from);
    if (word) ({ from, to } = word);
  }
  const label = state.sliceDoc(from, to) || 'link';
  view.dispatch({
    changes: { from, to, insert: `[${label}]()` },
    selection: { anchor: from + 1, head: from + 1 + label.length },
    userEvent: 'format',
  });
  view.dispatch({ effects: editLink.of(from + 1) });
  return true;
}

const URL_RE = /^(https?:\/\/|mailto:)\S+$/i;

/** Pasting an address over selected text links the text. */
const pasteLink = EditorView.domEventHandlers({
  paste(e, view) {
    const text = e.clipboardData?.getData('text/plain')?.trim() ?? '';
    const sel = view.state.selection.main;
    if (sel.empty || !URL_RE.test(text) || inCode(view.state, sel.from)) return false;
    e.preventDefault();
    const label = view.state.sliceDoc(sel.from, sel.to);
    view.dispatch({
      changes: { from: sel.from, to: sel.to, insert: `[${label}](${text})` },
      selection: { anchor: sel.from + label.length + 1 },
      userEvent: 'input.paste',
    });
    return true;
  },
});

// -------------------------------------------------------------- shortcuts

/** "[] " or "[ ] " at the start of a line makes a checklist item. */
const checklistRule = EditorView.inputHandler.of((view, from, to, text) => {
  if (text !== ' ') return false;
  const line = view.state.doc.lineAt(from);
  const before = view.state.sliceDoc(line.from, from);
  if (!/^\s*\[ ?\]$/.test(before) || inCode(view.state, from)) return false;
  const indent = /^\s*/.exec(before)![0];
  view.dispatch({
    changes: { from: line.from, to, insert: `${indent}- [ ] ` },
    selection: { anchor: line.from + indent.length + 6 },
    userEvent: 'input.type',
  });
  return true;
});

/**
 * Typing ``` at the start of a line makes an empty code block on the spot, closed, with the
 * cursor inside: an open fence would otherwise turn everything under it into code.
 */
const fenceRule = EditorView.inputHandler.of((view, from, to, text) => {
  if (text !== '`' || from !== to) return false;
  const line = view.state.doc.lineAt(from);
  const before = view.state.sliceDoc(line.from, from);
  const after = view.state.sliceDoc(to, line.to);
  if (!/^[ \t]*``$/.test(before) || after.trim() || inCode(view.state, line.from)) return false;
  const indent = /^[ \t]*/.exec(before)![0];
  view.dispatch({
    changes: {
      from: line.from,
      to: line.to,
      insert: `${indent}\`\`\`\n${indent}\n${indent}\`\`\``,
    },
    selection: { anchor: line.from + indent.length * 2 + 4 },
    userEvent: 'input.type',
  });
  return true;
});

/**
 * There's always a line after a table, rule or code block at the end of the page, so you can
 * keep writing under it.
 */
const roomAfterBlocks = EditorView.updateListener.of((u) => {
  if (!u.docChanged) return;
  const { blocks } = u.state.field(live);
  const len = u.state.doc.length;
  if (blocks.some(([, b]) => b === len))
    queueMicrotask(() => {
      if (u.view.state.doc.length === len)
        u.view.dispatch({ changes: { from: len, insert: '\n' } });
    });
});

const bindings: KeyBinding[] = [
  { key: 'Enter', run: enter },
  { key: 'Shift-Enter', run: softBreak },
  { key: 'Backspace', run: backspace },
  { key: 'Delete', run: deleteForward },
  {
    key: 'Tab',
    run: (v) =>
      inCode(v.state, v.state.selection.main.head) ? indentMore(v) : shiftItem(v, false) || true,
    shift: (v) =>
      inCode(v.state, v.state.selection.main.head) ? indentLess(v) : shiftItem(v, true) || true,
  },
  {
    // ← at the start of a list item's (or heading's) text: on to the end of the line above.
    key: 'ArrowLeft',
    run: (v) => {
      const sel = v.state.selection.main;
      if (!sel.empty) return false;
      const line = v.state.doc.lineAt(sel.head);
      if (line.number === 1 || prefixEnd(v.state, line.from) !== sel.head) return false;
      v.dispatch({
        selection: { anchor: line.from - 1 },
        scrollIntoView: true,
        userEvent: 'select',
      });
      return true;
    },
  },
  { key: 'Mod-b', run: (v) => toggleFormat(v, 'bold') },
  { key: 'Mod-i', run: (v) => toggleFormat(v, 'italic') },
  { key: 'Mod-Shift-x', run: (v) => toggleFormat(v, 'strike') },
  { key: 'Mod-e', run: (v) => toggleFormat(v, 'code') },
  { key: 'Mod-Shift-h', run: (v) => toggleFormat(v, 'highlight') },
  { key: 'Mod-k', run: linkCommand },
];

export function editorCommands(): Extension {
  return [
    pending,
    keymap.of(bindings),
    typeWithPending,
    checklistRule,
    fenceRule,
    pasteLink,
    roomAfterBlocks,
  ];
}

export { linkCommand };
