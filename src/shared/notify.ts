// What Nitrogen's notifications say and when: a morning digest of the to-dos and reminders due
// today, plus the app-icon count (open to-dos and reminders due today or overdue). Both come from
// the typed items index (see items.ts): "- [ ] todo: … due:YYYY-MM-DD", "- [ ] reminder: … due:…".
// Sending, the 8 a.m. timing and once-a-day are the Selfhost Kit's (src/worker/kit/push.ts).
import { pageHref, plainText } from './markdown';

/** The kinds of notification, each with its own switch in Settings. */
export const NOTIFY_KINDS = [
  {
    id: 'digest',
    label: 'Morning digest',
    description: 'Each morning, the to-dos and reminders due that day.',
  },
] as const;

export type NotifyKind = (typeof NOTIFY_KINDS)[number]['id'];

/** What the app-icon count counts, for the ⓘ in Settings. */
export const BADGE_MEANS = 'how many to-dos and reminders are due today or overdue';

/** The item types with a date that notifications and the badge follow (not questions). */
export const DATED_TYPES = ['todo', 'reminder'] as const;

/** An open item from the index, with its page. */
export interface DatedItem {
  page_id: string;
  page_title: string;
  line: number;
  type: string;
  text: string;
  due: string | null;
  done: boolean;
}

export interface Notice {
  kind: NotifyKind;
  /** What it's about (once per day each). */
  key: string;
  title: string;
  body: string;
  url: string;
  tag: string;
}

/** Open to-dos and reminders due on or before `today`. */
const dueBy = (items: readonly DatedItem[], today: string) =>
  items.filter(
    (i) =>
      !i.done && !!i.due && i.due <= today && (DATED_TYPES as readonly string[]).includes(i.type),
  );

/** The app-icon count: open to-dos and reminders due today or earlier. */
export function badgeCount(items: readonly DatedItem[], today: string): number {
  return dueBy(items, today).length;
}

/** Open to-dos and reminders due exactly today, by page then line. */
export function dueToday(items: readonly DatedItem[], today: string): DatedItem[] {
  return dueBy(items, today)
    .filter((i) => i.due === today)
    .sort(
      (a, b) =>
        a.page_title.localeCompare(b.page_title) ||
        a.page_id.localeCompare(b.page_id) ||
        a.line - b.line,
    );
}

/** Joins items up to about `max` characters, ending with "…" when some are left out. */
export function listUpTo(items: string[], sep: string, max: number): string {
  let out = '';
  for (const [i, s] of items.entries()) {
    const next = out ? `${out}${sep}${s}` : s;
    if (next.length > max && i > 0) return `${out}${sep}…`;
    out = next;
  }
  return out;
}

const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? '' : 's'}`;

/** "3 to-dos", "1 reminder", "2 to-dos and 1 reminder". */
function countWords(due: readonly DatedItem[]): string {
  const todos = due.filter((i) => i.type === 'todo').length;
  const reminders = due.length - todos;
  return [todos && plural(todos, 'to-do'), reminders && plural(reminders, 'reminder')]
    .filter(Boolean)
    .join(' and ');
}

/**
 * "Due today": "3 to-dos: Send the draft, Book the room, …". Opens the item when there's one,
 * its page when they're all on one page, else Home (whose Open items panel lists them).
 * Null when nothing is due today.
 */
export function digestNotice(items: readonly DatedItem[], today: string): Notice | null {
  const due = dueToday(items, today);
  if (!due.length) return null;
  const pages = new Set(due.map((i) => i.page_id));
  const first = due[0]!;
  const url =
    due.length === 1
      ? `${pageHref(first.page_id, first.page_title)}#item-${first.line}`
      : pages.size === 1
        ? pageHref(first.page_id, first.page_title)
        : '/';
  return {
    kind: 'digest',
    key: 'today',
    title: 'Due today',
    body: `${countWords(due)}: ${listUpTo(
      due.map((i) => plainText(i.text) || i.text),
      ', ',
      150,
    )}`,
    url,
    tag: 'digest-today',
  };
}
