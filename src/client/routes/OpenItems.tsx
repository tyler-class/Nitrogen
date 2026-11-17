// Open items: every open to-do, question and reminder in the wiki, on its own page. Summary
// notifications ("Due today", "Overdue", "Open questions") open it on the matching tab, so they
// always land on a list of exactly what they were about, whatever is hidden on Home. Items can be
// handled right here: check off to-dos, change a to-do's or reminder's date or time, answer a
// question. Reminders are nudges: no checkbox, never overdue, gone from here once they've passed. Each change edits that one line of its page, the same as doing it on the page.
import { useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useSearchParams } from 'react-router';
import { todayKey, nowMoment, reminderPast } from '@shared/items';
import type { OpenItem, Page } from '@shared/types';
import { api, errorMessage } from '../lib/api';
import { useToast } from '../components/Toast';
import { ItemsEmpty, OpenItemsToggle, parseShow, showFilter } from '../components/OpenItemsFilter';
import { Icon } from '../components/Icon';
import type { ItemEdit } from '@shared/items';
import { ItemRow } from '../components/ItemRow';
import { deleteItem } from '../lib/items';

export function OpenItems() {
  const [params, setParams] = useSearchParams();
  const asked = params.get('show');
  const show = parseShow(asked);
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
  const edit = (i: OpenItem, e: ItemEdit) => change(i, 'edit', e);
  const refresh = async (pageId: string) => {
    await qc.invalidateQueries({ queryKey: ['items'] });
    void qc.invalidateQueries({ queryKey: ['page', pageId] });
    void qc.invalidateQueries({ queryKey: ['dashboard'] });
  };
  async function remove(i: OpenItem) {
    try {
      const { undo } = await deleteItem(i.page_id, i.line);
      setHandled((m) => (m.delete(id(i)), new Map(m)));
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

  const today = todayKey();
  const fetched = q.data?.items ?? [];
  const open = new Set(fetched.map(id));
  // Handled items keep their place: still open ones come from the server, done ones from here.
  const now = nowMoment();
  // Past reminders were nudges: nothing left to do, so they're not listed.
  const live = fetched.filter((i) => !reminderPast(i, now));
  const all = [...live, ...[...handled.values()].filter((i) => !open.has(id(i)))];
  const list = all.filter(showFilter(today)[show]);

  return (
    <div className="page open-items-page">
      <h1 className="page-title view-title">
        <Icon name="checks" size={26} /> Open items
      </h1>
      <OpenItemsToggle
        value={show}
        onChange={(s) => setParams(s === 'all' ? {} : { show: s }, { replace: true })}
        items={q.data ? live : undefined}
        today={today}
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
              onEdit={(e) => edit(i, e)}
              onDelete={() => void remove(i)}
            />
          ))}
        </ul>
      ) : (
        <ItemsEmpty show={show} />
      )}
    </div>
  );
}
