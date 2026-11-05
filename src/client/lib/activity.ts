import { actorLabel } from '@shared/actor';
import type { EventAction, PageEvent } from '@shared/types';

const VERBS: Record<EventAction, string> = {
  create: 'created',
  edit: 'edited',
  move: 'moved',
  delete: 'deleted',
  restore: 'restored',
};

export const eventVerb = (e: PageEvent) => VERBS[e.action] ?? e.action;

/** "Claude edited", "You created". */
export function eventLine(e: PageEvent): string {
  return `${actorLabel(e.actor)} ${eventVerb(e)}`;
}

export function formatTime(iso: string): string {
  return new Date(iso).toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' });
}

export function formatDay(iso: string): string {
  const d = new Date(iso);
  const today = new Date();
  const yesterday = new Date(Date.now() - 86_400_000);
  if (d.toDateString() === today.toDateString()) return 'Today';
  if (d.toDateString() === yesterday.toDateString()) return 'Yesterday';
  return d.toLocaleDateString(undefined, {
    weekday: 'short',
    month: 'short',
    day: 'numeric',
    ...(d.getFullYear() !== today.getFullYear() ? { year: 'numeric' } : {}),
  });
}
