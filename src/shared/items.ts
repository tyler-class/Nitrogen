// Typed items: inline markers anywhere in a page that roll up into indexes and cards.
//
//   - [ ] todo: Draft the decision-log page @tyler due:2026-11-20
//   - [x] todo: Check the repo for export features
//   - reminder: Renew the domain due:2026-12-01            (reminders need a date)
//   - reminder: Call the dentist due:2026-11-12 14:00      (an optional 24-hour local time;
//                                                          "due:2026-11-12T14:00" works too)
//   - question: One marker with a type, or three?          (no checkbox = open)
//   - [x] question: One marker or three? answer: One, with a type word.
//   - [x] question: Which options?  answer: Two:              (an answer can go on over lines
//     - the first                                             indented under the item, with any
//     > and a quote                                           markdown: lists, quotes…)
//
// A to-do is a task: you check it off, and it goes overdue if you don't. A reminder is a nudge:
// it's scheduled for a day (and maybe a time), notifies you then, and simply passes; it has no
// checkbox and is never overdue. (A "[ ]" written on a reminder is ignored; "[x]" still hides it.)
//
// One shape for every type, so a new type (decision, risk) is just a new word in ITEM_TYPES.
// The markdown stays plain; the app renders these as cards and the server indexes them on save.
import { stripCode } from './markdown';

export const ITEM_TYPES = ['todo', 'question', 'reminder'] as const;
export type ItemType = (typeof ITEM_TYPES)[number];

export const ITEM_LABELS: Record<ItemType, string> = {
  todo: 'To do',
  question: 'Question',
  reminder: 'Reminder',
};

export interface Item {
  type: ItemType;
  /** 1-based line in the body. */
  line: number;
  /** The item text without the marker, checkbox, owner, due date or answer. */
  text: string;
  done: boolean;
  owner: string | null;
  /** YYYY-MM-DD. */
  due: string | null;
  /** HH:MM (24-hour, the reader's own clock) when the due date has a time, else null. */
  due_time: string | null;
  /** For questions resolved with "answer:" (markdown; may span lines). */
  answer: string | null;
  /** Lines after the item's own that its answer goes on over (indented under it). */
  answer_lines?: number;
  /** A reminder without a due date, or a due time that isn't a time. */
  invalid?: string;
}

/** List bullet (optional), checkbox (optional), then "type:" at the start of a line. */
export const ITEM_LINE_RE = new RegExp(
  `^(\\s*(?:[-*+]|\\d+[.)])?\\s*)(?:\\[([ xX])\\]\\s+)?(${ITEM_TYPES.join('|')}):\\s+(.*\\S)\\s*$`,
  'i',
);
/**
 * "due:" and an ISO date, optionally followed by a time ("due:2026-11-12 14:00" or
 * "due:2026-11-12T14:00"). The time is captured loosely (any H:MM or HH:MM) and checked by
 * dueTime(), so "due:2026-11-12 25:00" is flagged rather than left in the text.
 */
export const DUE_RE = /(?:^|\s)due:\s?(\d{4}-\d{2}-\d{2})(?:(?:T|\s+)(\d{1,2}:\d{2})(?![\d:]))?\b/i;

/** "14:00" or "9:30" as "HH:MM", or null when it isn't a time of day (00:00–23:59). */
export function dueTime(raw: string | null | undefined): string | null {
  const m = /^(\d{1,2}):(\d{2})$/.exec(raw ?? '');
  if (!m) return null;
  const h = Number(m[1]);
  const min = Number(m[2]);
  if (h > 23 || min > 59) return null;
  return `${String(h).padStart(2, '0')}:${m[2]}`;
}
const OWNER_RE = /(?:^|\s)@([\p{L}\p{N}._-]+)/u;
/** " answer: …" at the end of the line; the answer may also start on the lines below. */
const ANSWER_RE = /\s+answer:(?:\s+(.*))?$/i;

/** Parse the item on one line, or null if the line isn't one. */
export function parseItemLine(raw: string, line: number): Item | null {
  const m = ITEM_LINE_RE.exec(raw);
  if (!m) return null;
  const type = m[3]!.toLowerCase() as ItemType;
  let rest = m[4]!;
  let answer: string | null = null;
  const a = ANSWER_RE.exec(rest);
  if (a) {
    answer = (a[1] ?? '').trim();
    rest = rest.slice(0, a.index);
  }
  const d = DUE_RE.exec(rest);
  const due = d?.[1] ?? null;
  const due_time = dueTime(d?.[2]);
  const badTime = !!d?.[2] && !due_time;
  const owner = OWNER_RE.exec(rest)?.[1] ?? null;
  const text = rest
    .replace(DUE_RE, ' ')
    .replace(OWNER_RE, ' ')
    .replace(/\s{2,}/g, ' ')
    .trim();
  const done = (m[2] ?? ' ').toLowerCase() === 'x' || (type === 'question' && !!answer);
  return {
    type,
    line,
    text,
    done,
    owner,
    due,
    due_time,
    answer,
    ...(type === 'reminder' && !due
      ? { invalid: 'Reminders need a due date (due:YYYY-MM-DD).' }
      : badTime
        ? { invalid: `“${d![2]}” isn’t a time; use 24-hour HH:MM.` }
        : {}),
  };
}

/** How far an item's own content is indented: where its checkbox or type word starts. */
const indentOf = (raw: string) => ITEM_LINE_RE.exec(raw)?.[1]!.length ?? 0;

/**
 * How many lines after line `i` (0-based) continue the item on it: lines indented at least as far
 * as its content, and blank lines between them (not after them).
 */
function continuation(lines: string[], i: number): number {
  const indent = Math.max(1, indentOf(lines[i] ?? ''));
  let n = 0;
  let last = 0;
  for (let k = i + 1; k < lines.length; k++) {
    const l = lines[k]!;
    n++;
    if (!l.trim()) continue;
    if (l.length - l.trimStart().length < indent) break;
    last = n;
  }
  return last;
}

/** The answer on an item line (after "answer:") plus the lines it goes on over, unindented. */
function answerText(lines: string[], i: number, first: string, count: number): string {
  const indent = indentOf(lines[i] ?? '');
  const more = lines
    .slice(i + 1, i + 1 + count)
    .map((l) => (l.slice(0, indent).trim() ? l.trimStart() : l.slice(indent)));
  return [first, ...more].join('\n').replace(/^\n+/, '').trimEnd();
}

/** Every item in a page body, outside code blocks. */
export function extractItems(md: string): Item[] {
  const raw = md.split('\n');
  const lines = stripCode(md).split('\n');
  const out: Item[] = [];
  for (let i = 0; i < lines.length; i++) {
    const item = parseItemLine(lines[i]!, i + 1);
    if (!item) continue;
    // The text as written (code spans included), for showing and editing it.
    const asWritten = parseItemLine(raw[i]!, i + 1);
    if (asWritten) item.text = asWritten.text;
    // "answer:" with lines indented under it: they're the rest of the answer (skipped as items).
    if (item.answer !== null) {
      const count = continuation(raw, i);
      if (count) {
        item.answer = answerText(raw, i, item.answer, count);
        item.answer_lines = count;
        i += count;
      }
      if (!item.answer) item.answer = null;
      if (item.type === 'question' && item.answer) item.done = true;
    }
    out.push(item);
  }
  return out;
}

/** The item on `line` with its answer's extra lines, or null when the line isn't an item. */
function itemAt(md: string, line: number): Item | null {
  return extractItems(md).find((i) => i.line === line) ?? null;
}

/** Mark the item on `line` done or not done. null if that line isn't an item. */
export function setItemDone(md: string, line: number, done: boolean): string | null {
  const lines = md.split('\n');
  const raw = lines[line - 1];
  if (raw === undefined || !parseItemLine(stripCode(md).split('\n')[line - 1] ?? '', line))
    return null;
  const m = ITEM_LINE_RE.exec(raw)!;
  const lead = m[1]!.trimEnd() ? m[1]! : `${m[1]!}- `;
  const box = done ? '[x] ' : '[ ] ';
  lines[line - 1] = `${lead.endsWith(' ') ? lead : `${lead} `}${box}${m[3]}: ${m[4]}`;
  return lines.join('\n');
}

/**
 * Set (or clear) a to-do's or reminder's due date, with an optional time ("HH:MM"). The rest of
 * the line (text, @owner, checkbox, answer) is kept. null if that line isn't a to-do or reminder,
 * or when clearing a reminder's date (reminders need one).
 */
export function setItemDue(
  md: string,
  line: number,
  due: string | null,
  time: string | null = null,
): string | null {
  const lines = md.split('\n');
  const raw = lines[line - 1];
  const item =
    raw === undefined ? null : parseItemLine(stripCode(md).split('\n')[line - 1] ?? '', line);
  if (!item || item.type === 'question') return null;
  if (!due && item.type === 'reminder') return null;
  if (due && !/^\d{4}-\d{2}-\d{2}$/.test(due)) return null;
  const at = time ? dueTime(time) : null;
  if (time && !at) return null;
  const m = ITEM_LINE_RE.exec(raw!)!;
  let rest = m[4]!;
  let tail = '';
  const a = ANSWER_RE.exec(rest);
  if (a) {
    tail = rest.slice(a.index);
    rest = rest.slice(0, a.index);
  }
  rest = rest
    .replace(DUE_RE, ' ')
    .replace(/\s{2,}/g, ' ')
    .trim();
  const tag = due ? ` due:${due}${at ? ` ${at}` : ''}` : '';
  const box = m[2] !== undefined ? `[${m[2]}] ` : '';
  lines[line - 1] = `${m[1]}${box}${m[3]}: ${rest}${tag}${tail}`;
  return lines.join('\n');
}

/** Remove the item on `line` from the page (the whole line). null if that line isn't an item. */
export function removeItem(md: string, line: number): string | null {
  const item = itemAt(md, line);
  if (!item) return null;
  const lines = md.split('\n');
  lines.splice(line - 1, 1 + (item.answer_lines ?? 0));
  return lines.join('\n');
}

/** The lines removeItem() takes out (the item and its answer's extra lines), for undo. */
export function itemLines(md: string, line: number): string[] {
  const item = itemAt(md, line);
  if (!item) return [];
  return md.split('\n').slice(line - 1, line + (item.answer_lines ?? 0));
}

/** An answer written into the page: on the item's line, going on over indented lines below. */
function answerLines(answer: string, indent: number): { inline: string; below: string[] } {
  const parts = answer.replace(/\r\n?/g, '\n').trim().split('\n');
  const pad = ' '.repeat(indent);
  const blockStart = /^\s*([-*+]\s|\d+[.)]\s|>|#|```|~~~|\|)/;
  // Markdown that starts a block (a list, a quote…) can't follow "answer:" on the same line.
  const first = parts.length && !blockStart.test(parts[0]!) ? parts.shift()!.trim() : '';
  const below: string[] = [];
  parts.forEach((l, k) => {
    // A line of only "-" or "=" right under text would make that text a heading (and take the
    // question with it): a blank line first keeps it an empty bullet or a divider.
    const prev = k === 0 ? first : parts[k - 1]!;
    if (/^\s*(-+|=+)\s*$/.test(l) && prev.trim()) below.push('');
    below.push(l.trim() ? pad + l.trimEnd() : '');
  });
  return { inline: first, below };
}

/**
 * Set (or clear) a question's answer. Answering resolves it; clearing reopens it. The answer is
 * markdown and may have several lines: the first goes after "answer:", the rest are indented
 * under the item.
 */
export function setItemAnswer(md: string, line: number, answer: string): string | null {
  const item = itemAt(md, line);
  if (!item || item.type !== 'question') return null;
  const lines = md.split('\n');
  const raw = lines[line - 1]!;
  const m = ITEM_LINE_RE.exec(raw)!;
  const lead = m[1]!.trim() ? m[1]! : `${m[1]!}- `;
  const head = lead.endsWith(' ') ? lead : `${lead} `;
  const rest = m[4]!.replace(ANSWER_RE, '');
  const clean = answer.trim();
  const { inline, below } = answerLines(clean, head.length);
  const tag = clean ? ` answer:${inline ? ` ${inline}` : ''}` : '';
  lines.splice(
    line - 1,
    1 + (item.answer_lines ?? 0),
    `${head}${clean ? '[x] ' : '[ ] '}${m[3]}: ${rest}${tag}`,
    ...(clean ? below : []),
  );
  return lines.join('\n');
}

/** What the item editor can change: its type, text, and (not for questions) date and time. */
export interface ItemEdit {
  type: ItemType;
  text: string;
  due: string | null;
  time: string | null;
}

/**
 * Rewrite an item from the editor: its type, text, date and time. Its owner and done state stay;
 * a question keeps its answer (other types have none, so it's dropped). null if that line isn't
 * an item, or the edit isn't valid (no text, a reminder without a date, a bad date or time).
 */
export function editItem(md: string, line: number, edit: ItemEdit): string | null {
  const item = itemAt(md, line);
  if (!item) return null;
  const text = edit.text.replace(/\s+/g, ' ').trim();
  if (!text || !(ITEM_TYPES as readonly string[]).includes(edit.type)) return null;
  const dated = edit.type !== 'question';
  const due = dated ? edit.due : null;
  if (due && !/^\d{4}-\d{2}-\d{2}$/.test(due)) return null;
  if (edit.type === 'reminder' && !due) return null;
  const at = due && edit.time ? dueTime(edit.time) : null;
  if (due && edit.time && !at) return null;
  const lines = md.split('\n');
  const m = ITEM_LINE_RE.exec(lines[line - 1]!)!;
  const lead = m[1]!.trim() ? m[1]! : `${m[1]!}- `;
  const head = lead.endsWith(' ') ? lead : `${lead} `;
  // To-dos have a checkbox. Reminders and new questions don't (unless done: "[x]" marks that); a
  // question that stays a question keeps whatever it had.
  const box =
    edit.type === 'todo'
      ? `[${item.done ? 'x' : ' '}] `
      : edit.type === 'question' && item.type === 'question'
        ? m[2] !== undefined
          ? `[${m[2]}] `
          : ''
        : item.done
          ? '[x] '
          : '';
  const owner = item.owner ? ` @${item.owner}` : '';
  const tag = due ? ` due:${due}${at ? ` ${at}` : ''}` : '';
  const keepAnswer = edit.type === 'question' && item.type === 'question';
  const answer = keepAnswer ? (ANSWER_RE.exec(m[4]!)?.[0] ?? '') : '';
  const below = keepAnswer ? lines.slice(line, line + (item.answer_lines ?? 0)) : [];
  lines.splice(
    line - 1,
    1 + (item.answer_lines ?? 0),
    `${head}${box}${edit.type}: ${text}${owner}${tag}${answer}`,
    ...below,
  );
  return lines.join('\n');
}

/** Today as YYYY-MM-DD on this device's clock (in a Worker, which runs on UTC, that's the UTC date). */
export const todayKey = (d = new Date()) =>
  `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;

/** A moment on a clock: its date and minutes since midnight. */
export interface Moment {
  date: string;
  minutes: number;
}

/** Now on this device's clock. */
export function nowMoment(d = new Date()): Moment {
  return { date: todayKey(d), minutes: d.getHours() * 60 + d.getMinutes() };
}

/**
 * A reminder whose moment has gone by: its day is over, or (with a time) its time has passed.
 * Past reminders drop out of open lists; they were nudges, so there's nothing left to do.
 */
export function reminderPast(
  i: { type: string; due: string | null; due_time?: string | null },
  now: Moment,
): boolean {
  if (i.type !== 'reminder' || !i.due) return false;
  if (i.due !== now.date) return i.due < now.date;
  if (!i.due_time) return false;
  return now.minutes >= Number(i.due_time.slice(0, 2)) * 60 + Number(i.due_time.slice(3, 5));
}

/** A to-do (not a reminder or question) whose due date has gone by. */
export const isOverdue = (
  i: { type: string; due: string | null; done?: boolean },
  today: string,
): boolean => i.type === 'todo' && !i.done && !!i.due && i.due < today;

/** The words before a date: "Scheduled for" (reminders), "Overdue ·" or "Due" (to-dos). */
export function dateWords(
  i: { type: string; due: string | null; done?: boolean },
  today: string,
): string {
  if (i.type === 'reminder') return 'Scheduled for';
  return isOverdue(i, today) ? 'Overdue ·' : 'Due';
}
