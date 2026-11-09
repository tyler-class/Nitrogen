// What Nitrogen's notifications say and when, as pure functions (the Worker only loads data and
// hands it here; see src/worker/notifications.ts). Five kinds, each with its own switch:
//
//   digest     8 a.m.: the to-dos and reminders due today.
//   overdue    8 a.m. on the first day an open to-do or reminder is overdue (once per item).
//   timed      At an item's own time ("due:2026-11-12 14:00"), to the nearest cron run.
//   assistant  At most hourly: pages an assistant (MCP) created or edited.
//   questions  Monday 8 a.m.: questions still unanswered.
//
// Plus the app-icon count (open to-dos and reminders due today or overdue). Items come from the
// typed items index (items.ts). Sending and the once-a-day log are the Selfhost Kit's
// (src/worker/kit/push.ts); "once per item" comes from only offering an item on one local date.
// Every time here is the device's own clock (its IANA zone), so DST is the zone's business.
import { decodeActor } from './actor';
import { pageHref, plainText } from './markdown';

/** The kinds of notification, each with its own switch in Settings (all on by default). */
export const NOTIFY_KINDS = [
  {
    id: 'digest',
    label: 'Morning digest',
    description: 'At 8 a.m., what’s due that day.',
    detail:
      'Open to-dos and reminders due today, in one notification. Skipped when nothing is due.',
  },
  {
    id: 'overdue',
    label: 'Overdue',
    description: 'At 8 a.m. the day after something is due.',
    detail:
      'Once for each open to-do or reminder, on the first morning it’s overdue. Several that morning come as one.',
  },
  {
    id: 'timed',
    label: 'Timed reminders',
    description: 'At the time written on an item.',
    detail:
      'For to-dos and reminders with a time, like “due:2026-11-12 14:00”, on this device’s clock. Sent within about 15 minutes of it, once.',
  },
  {
    id: 'assistant',
    label: 'Assistant changes',
    description: 'When an assistant edits pages.',
    detail:
      'Pages an assistant like Claude created or edited over MCP, gathered into one notification an hour. Your own edits never notify. Nothing between midnight and 8 a.m.; those come at 8.',
  },
  {
    id: 'questions',
    label: 'Open questions',
    description: 'Monday at 8 a.m., questions still unanswered.',
    detail: 'Every “question:” item not yet answered. Skipped in weeks with none.',
  },
] as const;

export type NotifyKind = (typeof NOTIFY_KINDS)[number]['id'];

/** What the app-icon count counts, for the ⓘ in Settings. */
export const BADGE_MEANS = 'how many to-dos and reminders are due today or overdue';

/** The item types with a date that notifications and the badge follow (not questions). */
export const DATED_TYPES = ['todo', 'reminder'] as const;

/** Morning notifications (digest, overdue, questions) go out from this hour, local time. */
export const MORNING_HOUR = 8;

/** An item from the index, with its page. */
export interface DatedItem {
  page_id: string;
  page_title: string;
  line: number;
  type: string;
  text: string;
  due: string | null;
  /** "HH:MM" when the due date has a time. */
  due_time?: string | null;
  done: boolean;
}

export interface Notice {
  kind: NotifyKind;
  /** What it's about. The kit sends a (kind, key) once per local date. */
  key: string;
  title: string;
  body: string;
  url: string;
  tag: string;
}

// ---------------------------------------------------------------------------------------------
// The device's clock

/** A moment on a device's clock: its date, minutes since midnight (with seconds), weekday. */
export interface Clock {
  date: string;
  minutes: number;
  /** 0 = Sunday … 6 = Saturday. */
  weekday: number;
}

const clockFmts = new Map<string, Intl.DateTimeFormat>();
const WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

function validZone(tz: string) {
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: tz });
    return tz;
  } catch {
    return 'UTC';
  }
}

/** The wall clock in time zone `tz` at an instant. An unknown zone reads as UTC. */
export function localClock(at: Date, tz: string): Clock {
  let f = clockFmts.get(tz);
  if (!f) {
    f = new Intl.DateTimeFormat('en-US', {
      timeZone: validZone(tz),
      hourCycle: 'h23',
      weekday: 'short',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
    });
    clockFmts.set(tz, f);
  }
  const p = Object.fromEntries(f.formatToParts(at).map((x) => [x.type, x.value]));
  return {
    date: `${p.year}-${p.month}-${p.day}`,
    minutes: (Number(p.hour) % 24) * 60 + Number(p.minute) + Number(p.second) / 60,
    weekday: WEEKDAYS.indexOf(p.weekday ?? ''),
  };
}

/** "2026-11-10" plus `n` days. */
export function addDays(date: string, n: number): string {
  const [y, m, d] = date.split('-').map(Number);
  return new Date(Date.UTC(y!, m! - 1, d! + n)).toISOString().slice(0, 10);
}

/** "14:00" → 840. */
const minutesOf = (hhmm: string) => Number(hhmm.slice(0, 2)) * 60 + Number(hhmm.slice(3, 5));

/** "14:00" → "2:00 PM". */
export function formatClock(hhmm: string): string {
  const h = Number(hhmm.slice(0, 2));
  return `${h % 12 || 12}:${hhmm.slice(3, 5)} ${h < 12 ? 'AM' : 'PM'}`;
}

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

/** "2026-11-10" → "Nov 10". */
export const formatDay = (date: string) =>
  `${MONTHS[Number(date.slice(5, 7)) - 1]} ${Number(date.slice(8, 10))}`;

const isMorning = (c: Clock) => c.minutes >= MORNING_HOUR * 60;

// ---------------------------------------------------------------------------------------------
// Words

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

const words = (i: DatedItem) => plainText(i.text) || i.text;
const itemHref = (i: DatedItem) => `${pageHref(i.page_id, i.page_title)}#item-${i.line}`;
const byPage = (a: DatedItem, b: DatedItem) =>
  a.page_title.localeCompare(b.page_title) || a.page_id.localeCompare(b.page_id) || a.line - b.line;

/** A short, stable fingerprint of a string (FNV-1a), for keys that survive line moves. */
export function fingerprint(s: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 0x01000193);
  return (h >>> 0).toString(36);
}

// ---------------------------------------------------------------------------------------------
// The badge and the morning digest

const isDated = (i: DatedItem) =>
  !i.done && !!i.due && (DATED_TYPES as readonly string[]).includes(i.type);

/** Open to-dos and reminders due on or before `today` (a time doesn't matter: by date). */
const dueBy = (items: readonly DatedItem[], today: string) =>
  items.filter((i) => isDated(i) && i.due! <= today);

/** The app-icon count: open to-dos and reminders due today or earlier. */
export function badgeCount(items: readonly DatedItem[], today: string): number {
  return dueBy(items, today).length;
}

/** Open to-dos and reminders due exactly today, by page then line. */
export function dueToday(items: readonly DatedItem[], today: string): DatedItem[] {
  return dueBy(items, today)
    .filter((i) => i.due === today)
    .sort(byPage);
}

/**
 * "Due today": "3 to-dos: Send the draft, Call the dentist (2:00 PM), …". Opens the item when
 * there's one, its page when they're all on one page, else Home (whose Open items panel lists
 * them). Null when nothing is due today.
 */
export function digestNotice(items: readonly DatedItem[], today: string): Notice | null {
  const due = dueToday(items, today);
  if (!due.length) return null;
  const pages = new Set(due.map((i) => i.page_id));
  const first = due[0]!;
  const url =
    due.length === 1
      ? itemHref(first)
      : pages.size === 1
        ? pageHref(first.page_id, first.page_title)
        : '/';
  return {
    kind: 'digest',
    key: 'today',
    title: 'Due today',
    body: `${countWords(due)}: ${listUpTo(
      due.map((i) => (i.due_time ? `${words(i)} (${formatClock(i.due_time)})` : words(i))),
      ', ',
      150,
    )}`,
    url,
    tag: 'digest-today',
  };
}

// ---------------------------------------------------------------------------------------------
// Overdue

/** Open to-dos and reminders whose first overdue day is `today` (due yesterday). */
export function newlyOverdue(items: readonly DatedItem[], today: string): DatedItem[] {
  const yesterday = addDays(today, -1);
  return items.filter((i) => isDated(i) && i.due === yesterday).sort(byPage);
}

/**
 * "Overdue: Renew the domain (due Nov 10)". Several that morning are one notification: "Overdue:
 * 2 to-dos and 1 reminder (due Nov 10): …", opening Home. Each item is only ever offered on its
 * first overdue day, so it's sent once. Null when nothing became overdue today.
 */
export function overdueNotice(items: readonly DatedItem[], today: string): Notice | null {
  const late = newlyOverdue(items, today);
  if (!late.length) return null;
  const day = formatDay(addDays(today, -1));
  const one = late.length === 1;
  return {
    kind: 'overdue',
    key: 'first-day',
    title: 'Overdue',
    body: one
      ? `${words(late[0]!)} (due ${day})`
      : `${countWords(late)} (due ${day}): ${listUpTo(late.map(words), ', ', 150)}`,
    url: one ? itemHref(late[0]!) : '/',
    tag: 'overdue',
  };
}

// ---------------------------------------------------------------------------------------------
// Timed reminders

/** How early a timed item may go: half the 15-minute cron, so it's the run nearest the time. */
export const TIMED_EARLY_MIN = 7.5;
/** How late it may still go (a missed run, a failed send): after that it's skipped. */
export const TIMED_LATE_MIN = 120;
/** The last cron run of a day: a time after 23:52 goes then rather than not at all. */
const LAST_RUN_MIN = 23 * 60 + 44;

/**
 * Whether a timed item is due to go out now: on its due date (the device's clock), from the
 * cron run nearest its time until two hours after. DST is the zone's: a time skipped by a
 * spring-forward goes at the first run after the jump, and a time that happens twice in the
 * autumn goes the first time (the same date and key, so the kit won't send it again).
 */
export function timedDue(item: DatedItem, now: Clock): boolean {
  if (!isDated(item) || !item.due_time || item.due !== now.date) return false;
  const at = minutesOf(item.due_time);
  const from = Math.min(at - TIMED_EARLY_MIN, LAST_RUN_MIN);
  return now.minutes >= from && now.minutes < at + TIMED_LATE_MIN;
}

/**
 * "Reminder: Call the dentist (2:00 PM)", one notification per item, opening it. The key is the
 * page, date, time and text, so moving the line doesn't send it again; changing the time does.
 */
export function timedNotices(items: readonly DatedItem[], now: Clock): Notice[] {
  return items
    .filter((i) => timedDue(i, now))
    .sort((a, b) => a.due_time!.localeCompare(b.due_time!) || byPage(a, b))
    .map((i) => ({
      kind: 'timed',
      key: `${i.page_id}:${i.due}T${i.due_time}:${fingerprint(i.text)}`,
      title: i.type === 'reminder' ? 'Reminder' : 'To-do',
      body: `${words(i)} (${formatClock(i.due_time!)})`,
      url: itemHref(i),
      tag: `timed-${i.page_id}-${i.line}`,
    }));
}

// ---------------------------------------------------------------------------------------------
// Assistant changes

/** One activity-log row by an assistant, with whether its page still exists. */
export interface AssistantEvent {
  page_id: string;
  title: string;
  action: string;
  /** Encoded actor: "agent:Claude". Anything else ("you", null) is ignored. */
  actor: string | null;
  /** The page still exists (it can be opened). */
  live: boolean;
}

/** The hour of activity one assistant notification covers: [from, to). */
export interface AssistantWindow {
  from: Date;
  to: Date;
  /** Sent once per window. */
  key: string;
}

const HOUR = 3_600_000;

/**
 * Which assistant edits to report now. Notifications go out once an hour, on the first run of
 * each hour, about the hour before it: [to − 1h, to). Between midnight and 8 a.m. (the device's
 * clock) nothing goes out; the first hour from 8 covers the night too. Null when this run sends
 * nothing (quiet hours, or the device's date changed partway through this hour, as it does in
 * half-hour zones, so the kit's once-a-day log can't send one hour twice).
 */
export function assistantWindow(now: Date, tz: string): AssistantWindow | null {
  const to = new Date(Math.floor(now.getTime() / HOUR) * HOUR);
  const sendable = (t: Date) => isMorning(localClock(t, tz));
  if (!sendable(to) || localClock(to, tz).date !== localClock(now, tz).date) return null;
  let from = new Date(to.getTime() - HOUR);
  for (let n = 0; n < 24 && !sendable(from); n++) from = new Date(from.getTime() - HOUR);
  return { from, to, key: to.toISOString().slice(0, 13) };
}

/** "Claude", "Claude and ChatGPT", "3 assistants". */
function whoWords(actors: string[]): string {
  const names = [...new Set(actors.map((a) => decodeActor(a)?.name ?? 'An assistant'))];
  if (names.length === 1) return names[0]!;
  if (names.length === 2) return `${names[0]} and ${names[1]}`;
  return `${names.length} assistants`;
}

/**
 * "Claude updated 3 pages: Trip ideas, Garden, …" ("created" when every change was a new page).
 * Opens the page when there's one still there, else Activity. Null when no assistant changed
 * anything. `events` is newest first.
 */
export function assistantNotice(
  events: readonly AssistantEvent[],
  window: AssistantWindow,
): Notice | null {
  const mine = events.filter((e) => decodeActor(e.actor)?.kind === 'agent');
  if (!mine.length) return null;
  const pages = new Map<string, AssistantEvent>();
  for (const e of mine) if (!pages.has(e.page_id)) pages.set(e.page_id, e);
  const list = [...pages.values()];
  const verb = mine.every((e) => e.action === 'create') ? 'created' : 'updated';
  const who = whoWords(mine.map((e) => e.actor!));
  const one = list.length === 1 ? list[0]! : null;
  return {
    kind: 'assistant',
    key: window.key,
    title: 'Assistant changes',
    body: one
      ? `${who} ${verb} ${one.title}`
      : `${who} ${verb} ${list.length} pages: ${listUpTo(
          list.map((e) => e.title),
          ', ',
          150,
        )}`,
    url: one?.live ? pageHref(one.page_id, one.title) : '/activity',
    tag: 'assistant-changes',
  };
}

// ---------------------------------------------------------------------------------------------
// Open questions

/** Where Home's Open items panel shows questions only. */
export const QUESTIONS_URL = '/?items=question';

/**
 * Monday from 8 a.m.: "4 open questions: Which hosting plan?, …", opening Home's Open items on
 * questions. Null on other days, before 8, or when every question is answered.
 */
export function questionsNotice(items: readonly DatedItem[], now: Clock): Notice | null {
  if (now.weekday !== 1 || !isMorning(now)) return null;
  const open = items.filter((i) => i.type === 'question' && !i.done).sort(byPage);
  if (!open.length) return null;
  return {
    kind: 'questions',
    key: 'week',
    title: 'Open questions',
    body: `${plural(open.length, 'open question')}: ${listUpTo(open.map(words), ', ', 150)}`,
    url: QUESTIONS_URL,
    tag: 'open-questions',
  };
}

// ---------------------------------------------------------------------------------------------
// Everything a device could get now

/**
 * Every notice due now on a device's clock. `items` is the open items (dated and questions);
 * `events` the assistant activity in `window` (assistantWindow for this device, or null).
 * The kit drops kinds the device switched off and anything already sent today.
 */
export function noticesNow(
  items: readonly DatedItem[],
  now: Clock,
  events: readonly AssistantEvent[] = [],
  window: AssistantWindow | null = null,
): Notice[] {
  const out: (Notice | null)[] = [];
  if (isMorning(now)) {
    out.push(digestNotice(items, now.date), overdueNotice(items, now.date));
    out.push(questionsNotice(items, now));
  }
  out.push(...timedNotices(items, now));
  if (window) out.push(assistantNotice(events, window));
  return out.filter((n): n is Notice => !!n);
}
