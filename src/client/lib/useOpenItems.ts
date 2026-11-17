// Every open item in the wiki, and what you can do to one from a list of them (check off, answer,
// edit, delete). Shared by the Open Items page and Home's Open Items card, so both behave the same.
// Each change edits that one line of its page, the same as doing it on the page.
import { useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { nowMoment, reminderPast, type ItemEdit } from '@shared/items';
import type { OpenItem, Page } from '@shared/types';
import { api, errorMessage } from './api';
import { deleteItem } from './items';
import { useToast } from '../components/Toast';

const idOf = (i: OpenItem) => `${i.page_id}:${i.line}`;

export function useOpenItems() {
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

  const refresh = async (pageId: string) => {
    await qc.invalidateQueries({ queryKey: ['items'] });
    void qc.invalidateQueries({ queryKey: ['page', pageId] });
    void qc.invalidateQueries({ queryKey: ['dashboard'] });
  };

  /** Post a change to one item's line, then refresh everything that shows it. */
  async function change(i: OpenItem, path: string, payload: object, after?: OpenItem) {
    try {
      await api.post<Page>(`/pages/${i.page_id}/items/${path}`, { line: i.line, ...payload });
      if (after) setHandled((m) => new Map(m).set(idOf(i), after));
      await refresh(i.page_id);
    } catch (e) {
      toast(errorMessage(e));
    }
  }
  const setDone = (i: OpenItem, done: boolean) => {
    if (!done) setHandled((m) => (m.delete(idOf(i)), new Map(m)));
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
  const edit = (i: OpenItem, e: ItemEdit) => change(i, 'edit', e);
  async function remove(i: OpenItem) {
    try {
      const { undo } = await deleteItem(i.page_id, i.line);
      setHandled((m) => (m.delete(idOf(i)), new Map(m)));
      await refresh(i.page_id);
      toast('Item deleted.', {
        label: 'Undo',
        run: () =>
          void undo()
            .then(() => refresh(i.page_id))
            .catch((e) => toast(errorMessage(e))),
      });
    } catch (e) {
      toast(errorMessage(e));
    }
  }

  const fetched = q.data?.items ?? [];
  const open = new Set(fetched.map(idOf));
  // Past reminders were nudges: nothing left to do, so they're not listed.
  const now = nowMoment();
  const live = fetched.filter((i) => !reminderPast(i, now));
  // Handled items keep their place: still open ones come from the server, done ones from here.
  const all = [...live, ...[...handled.values()].filter((i) => !open.has(idOf(i)))];

  /** The props an ItemRow needs for item `i`. */
  const rowProps = (i: OpenItem) => ({
    onDone: (d: boolean) => void setDone(i, d),
    onAnswer: (t: string) => answer(i, t),
    onEdit: (e: ItemEdit) => edit(i, e),
    onDelete: () => void remove(i),
  });

  return { q, live: q.data ? live : undefined, all, idOf, rowProps };
}
