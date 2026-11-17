// Open items: every open to-do, question and reminder in the wiki, on its own page. Summary
// notifications ("Due today", "Overdue", "Open questions") open it on the matching tab, so they
// always land on a list of exactly what they were about, whatever is hidden on Home. Items can be
// handled right here: check off to-dos, change a to-do's or reminder's date or time, answer a
// question. Reminders are nudges: no checkbox, never overdue, gone from here once they've passed. Each change edits that one line of its page, the same as doing it on the page.
import { useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useSearchParams } from 'react-router';
import { todayKey, isOverdue, nowMoment, reminderPast } from '@shared/items';
import type { OpenItem, Page } from '@shared/types';
import { api, errorMessage } from '../lib/api';
import { useToast } from '../components/Toast';
import { SlideToggle } from '../components/charts';
import { Icon } from '../components/Icon';
import { ItemRow } from '../components/ItemRow';

const SHOWS = ['all', 'today', 'overdue', 'questions'] as const;
type Show = (typeof SHOWS)[number];

const EMPTY: Record<Show, string> = {
  today: 'Nothing due or scheduled today.',
  overdue: 'Nothing overdue.',
  questions: 'No open questions.',
  all: 'Nothing open. Write “- [ ] todo: …” on any page.',
};

export function OpenItems() {
  const [params, setParams] = useSearchParams();
  const asked = params.get('show');
  const show: Show = (SHOWS as readonly string[]).includes(asked ?? '') ? (asked as Show) : 'all';
  const q = useQuery({
    queryKey: ['items'],
    queryFn: () => api.get<{ items: OpenItem[] }>('/items'),
    refetchInterval: 60_000,
  });
  const qc = useQueryClient();
  const toast = useToast();
  // Items handled here stay listed (checked, struck through) until you leave, so a mis-tap can be
  // undone by unchecking.
  const [handled, setHandled] = useState<Map<string, OpenItem>>(new Map());
  const id = (i: OpenItem) => `${i.page_id}:${i.line}`;

  /** Post a change to one item's line, then refresh everything that shows it. */
  async function change(i: OpenItem, path: string, payload: object, after?: OpenItem) {
    try {
      await api.post<Page>(`/pages/${i.page_id}/items/${path}`, { line: i.line, ...payload });
      if (after) setHandled((m) => new Map(m).set(id(i), after));
      await qc.invalidateQueries({ queryKey: ['items'] });
      void qc.invalidateQueries({ queryKey: ['page', i.page_id] });
      void qc.invalidateQueries({ queryKey: ['dashboard'] });
    } catch (e) {
      toast(errorMessage(e));
    }
  }
  const setDone = (i: OpenItem, done: boolean) => {
    if (!done) setHandled((m) => (m.delete(id(i)), new Map(m)));
    // An answered question is done because of its answer: reopening it clears the answer.
    if (!done && i.type === 'question' && i.answer) return change(i, 'answer', { answer: '' });
    return change(i, 'toggle', { done }, done ? { ...i, done: true } : undefined);
  };
  const answer = (i: OpenItem, text: string) =>
    change(
      i,
      'answer',
      { answer: text },
      text.trim() ? { ...i, done: true, answer: text } : undefined,
    );
  const setDue = (i: OpenItem, due: string | null, time: string | null) =>
    change(i, 'due', { due, time });

  const today = todayKey();
  const fetched = q.data?.items ?? [];
  const open = new Set(fetched.map(id));
  // Handled items keep their place: still open ones come from the server, done ones from here.
  const now = nowMoment();
  // Past reminders were nudges: nothing left to do, so they're not listed.
  const live = fetched.filter((i) => !reminderPast(i, now));
  const all = [...live, ...[...handled.values()].filter((i) => !open.has(id(i)))];
  const pick: Record<Show, (i: OpenItem) => boolean> = {
    today: (i) => i.type !== 'question' && i.due === today,
    overdue: (i) => isOverdue(i, today),
    questions: (i) => i.type === 'question',
    all: () => true,
  };
  const count = (s: Show) => live.filter(pick[s]).length;
  const list = all.filter(pick[show]);

  return (
    <div className="page open-items-page">
      <h1 className="page-title view-title">
        <Icon name="checks" size={26} /> Open items
      </h1>
      <SlideToggle<Show>
        label="Show"
        value={show}
        onChange={(s) => setParams(s === 'all' ? {} : { show: s }, { replace: true })}
        options={[
          ['all', `All${q.data ? ` · ${live.length}` : ''}`],
          ['today', `Today${q.data ? ` · ${count('today')}` : ''}`],
          ['overdue', `Overdue${q.data ? ` · ${count('overdue')}` : ''}`],
          ['questions', `Questions${q.data ? ` · ${count('questions')}` : ''}`],
        ]}
      />
      {q.isPending ? (
        <p className="muted">Loading…</p>
      ) : list.length ? (
        <ul className="items-full">
          {list.map((i) => (
            <ItemRow
              key={id(i)}
              item={i}
              today={today}
              onDone={(d) => void setDone(i, d)}
              onAnswer={(t) => answer(i, t)}
              onDue={(d, t) => setDue(i, d, t)}
            />
          ))}
        </ul>
      ) : (
        <p className="muted items-empty">{EMPTY[show]}</p>
      )}
    </div>
  );
}
