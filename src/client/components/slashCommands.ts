// "/" commands: type a slash at the start of a line (or after a space) for a small menu of
// blocks to insert. Each writes plain markdown, with the cursor where you'd type next.
import {
  startCompletion,
  type Completion,
  type CompletionContext,
  type CompletionResult,
} from '@codemirror/autocomplete';
import { syntaxTree } from '@codemirror/language';
import type { EditorView } from '@codemirror/view';
import { blockContext } from './editorCommands';
import { calloutAround, openDueAt, parseListLine } from './livePreview';
import { focusTableAt } from './tableWidget';

interface Command {
  label: string;
  icon: string;
  /** The markdown, with "§" where the cursor goes (or "§…§" around text to select). */
  text?: string | (() => string);
  /** A block that needs a blank line around it (tables, rules and code stand on their own). */
  alone?: boolean;
  /** The cursor goes on past the block (a rule; a table puts it in its first cell). */
  past?: boolean;
  /** What goes after a block that stands alone (a blank line, unless it says otherwise). */
  after?: string;
  /** Inline: written where the slash was, not on a line of its own. */
  inline?: boolean;
  then?: (view: EditorView, start: number) => void;
  /** Only inside a typed item (adds its due date). */
  due?: boolean;
  /** Does something other than insert text (the slash is already gone). */
  run?: (view: EditorView, at: number) => void;
}

/** A date as YYYY-MM-DD, `days` from today (local). */
function inDays(days: number): string {
  const d = new Date(Date.now() + days * 86_400_000);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

function commands(pickImages: () => void): Command[] {
  return [
    { label: 'To Do', icon: 'check', text: '- [ ] todo: §' },
    { label: 'Question', icon: 'question', text: '- question: §' },
    { label: 'Reminder', icon: 'bell', text: () => `- reminder: § due:${inDays(7)}` },
    {
      label: 'Due date',
      icon: 'calendar',
      // Only offered inside a to-do, question or reminder: a date a week out (tap it to change).
      due: true,
      run: (view, at) => {
        const line = view.state.doc.lineAt(at);
        if (!parseListLine(line.text)?.type || /\sdue:/.test(line.text)) return;
        const end = line.from + line.text.replace(/\s+$/, '').length;
        view.dispatch({
          changes: { from: end, to: line.to, insert: ` due:${inDays(7)}` },
          selection: { anchor: end },
        });
        // The calendar opens on it, ready to pick the day.
        openDueAt(view, end + 1);
      },
    },
    { label: 'Heading 1', icon: 'h1', text: '# §' },
    { label: 'Heading 2', icon: 'h2', text: '## §' },
    { label: 'Heading 3', icon: 'h3', text: '### §' },
    { label: 'Bulleted list', icon: 'list', text: '- §' },
    { label: 'Numbered list', icon: 'numbered', text: '1. §' },
    { label: 'Task list', icon: 'checkbox', text: '- [ ] §' },
    { label: 'Note', icon: 'note', text: '> [!NOTE]\n> §' },
    { label: 'Tip', icon: 'bulb', text: '> [!TIP]\n> §' },
    { label: 'Warning', icon: 'warning', text: '> [!WARNING]\n> §' },
    { label: 'Quote', icon: 'quote', text: '> §' },
    {
      label: 'Table',
      icon: 'table',
      text: '|  |  |\n| --- | --- |\n|  |  |§',
      alone: true,
      past: true,
      then: (view, start) => focusTableAt(view, start),
    },
    { label: 'Code', icon: 'code', text: '```\n§\n```', alone: true },
    {
      label: 'Diagram',
      icon: 'graph',
      text: '```mermaid\nflowchart LR\n  A[§Start§] --> B{Decision}\n  B -->|Yes| C[Do it]\n  B -->|No| D[Skip]\n```',
      alone: true,
    },
    // The cursor goes on the line right under it.
    { label: 'Divider', icon: 'divider', text: '---§', alone: true, past: true, after: '\n' },
    {
      label: 'Link to page',
      icon: 'link',
      text: '@§',
      inline: true,
      then: (view) => startCompletion(view),
    },
    { label: 'Image', icon: 'image', run: () => pickImages() },
  ];
}

/** The menu's sections, in order, each with a small heading. */
const SECTIONS = {
  action: { name: 'Action items', rank: 0 },
  text: { name: 'Text formatting', rank: 1 },
  callout: { name: 'Callouts', rank: 2 },
  other: { name: 'Other', rank: 3 },
};
function sectionOf(label: string) {
  if (['To Do', 'Question', 'Reminder', 'Due date'].includes(label)) return SECTIONS.action;
  if (/^Heading|list$/.test(label)) return SECTIONS.text;
  if (label === 'Quote') return SECTIONS.text;
  if (['Note', 'Tip', 'Warning'].includes(label)) return SECTIONS.callout;
  return SECTIONS.other;
}

/** Puts the command's markdown in place of "/query" and the cursor where it says. */
function insert(view: EditorView, cmd: Command, from: number, to: number, typed = true) {
  const doc = view.state.doc;
  // From the "/" menu the slash and what was typed after it go; from the phone bar, nothing does.
  const slash = typed ? from - 1 : from;
  if (cmd.run) {
    if (typed) view.dispatch({ changes: { from: slash, to }, selection: { anchor: slash } });
    cmd.run(view, slash);
    return;
  }
  const line = doc.lineAt(slash);
  // In a quote or callout, a new line keeps its ">" (and what's before the cursor is after it).
  const qrun = /^(?:[ \t]*>[ \t]?)+/.exec(line.text)?.[0] ?? '';
  const inQuote = !!qrun && slash >= line.from + qrun.length;
  const before = doc.sliceString(line.from + (inQuote ? qrun.length : 0), slash);
  const raw = typeof cmd.text === 'function' ? cmd.text() : cmd.text!;
  let lead = '';
  if (!cmd.inline) {
    // Blocks start their own line; ones that stand alone get a blank line above too.
    if (before.trim()) lead = cmd.alone ? '\n\n' : `\n${inQuote ? qrun : ''}`;
    else if (cmd.alone && line.number > 1 && doc.line(line.number - 1).text.trim()) lead = '\n';
  }
  // A callout or quote right under (or over) another one would run into it and show as its
  // text: a blank line keeps them apart.
  const quoted = (n: number) => n >= 1 && n <= doc.lines && /^\s*>/.test(doc.line(n).text);
  if (raw.startsWith('>') && !lead && quoted(line.number - 1)) lead = '\n';
  // ...and below (text right under a table would join it as a row).
  const tail = cmd.alone
    ? (cmd.after ?? '\n\n')
    : raw.startsWith('>') && quoted(line.number + 1)
      ? '\n'
      : '';
  const a = raw.indexOf('§');
  const b = raw.indexOf('§', a + 1);
  const text = raw.replaceAll('§', '');
  const start = slash + lead.length;
  view.dispatch({
    changes: { from: slash, to, insert: lead + text + tail },
    selection: cmd.past
      ? { anchor: start + text.length + tail.length }
      : b > a
        ? { anchor: start + a, head: start + b - 1 }
        : { anchor: start + a },
    scrollIntoView: true,
    userEvent: 'input.complete',
  });
  cmd.then?.(view, start);
}

/** Blocks that can't go inside a quote or callout (they hold text, lists and quotes only). */
export const NOT_IN_QUOTE = [
  'Note',
  'Tip',
  'Warning',
  'Table',
  'Code',
  'Diagram',
  'Divider',
  'Image',
];
/** Not inside a callout either: to-dos, questions, reminders and their dates. */
export const NOT_IN_CALLOUT = ['To Do', 'Question', 'Reminder', 'Due date'];

/** Inserts a block from the "/" menu's list at the cursor (the phone's format bar). */
export function insertBlock(view: EditorView, label: string, pickImages: () => void) {
  const cmd = commands(pickImages).find((c) => c.label === label);
  if (!cmd) return;
  const head = view.state.selection.main.head;
  const where = blockContext(view.state, head);
  if (where === 'code' || (where === 'quote' && NOT_IN_QUOTE.includes(label))) return;
  if (
    NOT_IN_CALLOUT.includes(label) &&
    calloutAround(view.state.doc, view.state.doc.lineAt(head).number)
  )
    return;
  const { from, to } = view.state.selection.main;
  insert(view, cmd, from, to, false);
}

export function slashSource(pickImages: () => void) {
  const list = commands(pickImages);
  const all: (Completion & { due?: boolean })[] = list.map((cmd, i) => ({
    label: cmd.label,
    type: 'command',
    boost: 99 - i,
    section: sectionOf(cmd.label),
    apply: (view, _c, from, to) => insert(view, cmd, from, to),
    // Read by the editor's option renderer for the icon.
    cmd: cmd.icon,
    due: cmd.due,
  }));
  const blocks = all.filter((o) => !o.due);
  return (ctx: CompletionContext): CompletionResult | null => {
    const m = ctx.matchBefore(/(?:^|\s)\/[\w ]{0,20}$/);
    if (!m) return null;
    const slash = m.from + m.text.indexOf('/');
    // Not in code, and not mid-word ("and/or") or in an address.
    const node = syntaxTree(ctx.state).resolveInner(slash, -1);
    for (let n: typeof node | null = node; n; n = n.parent)
      if (/Code|URL|Link/.test(n.name)) return null;
    // A space right after the slash, or two spaces, means it was just a slash.
    const query = ctx.state.sliceDoc(slash + 1, ctx.pos);
    if (/^\s|\s\s/.test(query)) return null;
    // Due date only on a to-do, question or reminder line (one without a date yet).
    const line = ctx.state.doc.lineAt(slash);
    const onItem = !!parseListLine(line.text)?.type && !/\sdue:/.test(line.text);
    // In a quote or callout, only what it can hold.
    const inQuote = blockContext(ctx.state, slash) === 'quote';
    const inCallout = !!calloutAround(ctx.state.doc, line.number);
    const options = (onItem ? all : blocks).filter(
      (o) =>
        (!inQuote || !NOT_IN_QUOTE.includes(o.label)) &&
        (!inCallout || !NOT_IN_CALLOUT.includes(o.label)),
    );
    return { from: slash + 1, options, validFor: /^[\w]*( [\w]*)?$/ };
  };
}
