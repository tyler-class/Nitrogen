// Typed items: inline markers anywhere in a page that roll up into indexes and cards.
//
//   - [ ] todo: Draft the decision-log page @tyler due:2026-11-20
//   - [x] todo: Check the repo for export features
//   - [ ] reminder: Renew the domain due:2026-12-01        (reminders need a due date)
//   - [ ] reminder: Call the dentist due:2026-11-12 14:00  (an optional 24-hour local time;
//                                                          "due:2026-11-12T14:00" works too)
//   - question: One marker with a type, or three?          (no checkbox = open)
//   - [x] question: One marker or three? answer: One, with a type word.
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
  /** For questions resolved with "answer:". */
  answer: string | null;
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
const ANSWER_RE = /\s+answer:\s+(.*)$/i;

/** Parse the item on one line, or null if the line isn't one. */
export function parseItemLine(raw: string, line: number): Item | null {
  const m = ITEM_LINE_RE.exec(raw);
  if (!m) return null;
  const type = m[3]!.toLowerCase() as ItemType;
  let rest = m[4]!;
  let answer: string | null = null;
  const a = ANSWER_RE.exec(rest);
  if (a) {
    answer = a[1]!.trim();
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

/** Every item in a page body, outside code blocks. */
export function extractItems(md: string): Item[] {
  const lines = stripCode(md).split('\n');
  const out: Item[] = [];
  lines.forEach((l, i) => {
    const item = parseItemLine(l, i + 1);
    if (item) out.push(item);
  });
  return out;
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

/** Set (or clear) a question's answer. Answering resolves it; clearing reopens it. */
export function setItemAnswer(md: string, line: number, answer: string): string | null {
  const lines = md.split('\n');
  const raw = lines[line - 1];
  const item =
    raw === undefined ? null : parseItemLine(stripCode(md).split('\n')[line - 1] ?? '', line);
  if (!item || item.type !== 'question') return null;
  const m = ITEM_LINE_RE.exec(raw!)!;
  const lead = m[1]!.trim() ? m[1]! : `${m[1]!}- `;
  const rest = m[4]!.replace(/\s+answer:\s+.*$/i, '');
  const clean = answer.replace(/\s+/g, ' ').trim();
  lines[line - 1] =
    `${lead.endsWith(' ') ? lead : `${lead} `}${clean ? '[x] ' : '[ ] '}${m[3]}: ${rest}${clean ? ` answer: ${clean}` : ''}`;
  return lines.join('\n');
}

/** Today in UTC as YYYY-MM-DD. */
/** Today as YYYY-MM-DD on this device's clock (in a Worker, which runs on UTC, that's the UTC date). */
export const todayKey = (d = new Date()) =>
  `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
