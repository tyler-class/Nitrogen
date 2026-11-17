// The one filter for open items, the same on Home and on the Open Items page: All, Today,
// Overdue, Questions, each with its count. Plus the empty state for each.
import { isOverdue } from '@shared/items';
import type { OpenItem } from '@shared/types';
import { SlideToggle } from './charts';
import { EmptyState } from './EmptyState';

export const SHOWS = ['all', 'today', 'overdue', 'questions'] as const;
export type Show = (typeof SHOWS)[number];

export const parseShow = (v: string | null): Show =>
  (SHOWS as readonly string[]).includes(v ?? '') ? (v as Show) : 'all';

/** Which items each choice shows. */
export function showFilter(today: string): Record<Show, (i: OpenItem) => boolean> {
  return {
    today: (i) => i.due === today,
    overdue: (i) => isOverdue(i, today),
    questions: (i) => i.type === 'question',
    all: () => true,
  };
}

/** The Open Items page for a choice ("View all" from Home lands on the same one). */
export const showHref = (s: Show) => (s === 'all' ? '/items' : `/items?show=${s}`);

export function OpenItemsToggle({
  value,
  onChange,
  items,
  today,
}: {
  value: Show;
  onChange(s: Show): void;
  /** The open items, for the counts (none while loading). */
  items: OpenItem[] | undefined;
  today: string;
}) {
  const f = showFilter(today);
  const n = (s: Show) => (items ? ` · ${items.filter(f[s]).length}` : '');
  return (
    <SlideToggle<Show>
      label="Show"
      value={value}
      onChange={onChange}
      options={[
        ['all', `All${n('all')}`],
        ['today', `Today${n('today')}`],
        ['overdue', `Overdue${n('overdue')}`],
        ['questions', `Questions${n('questions')}`],
      ]}
    />
  );
}

const EMPTY: Record<Show, [string, string]> = {
  all: ['All clear', 'No open to-dos, questions or reminders.'],
  today: ['Nothing today', 'No to-dos due or reminders scheduled today.'],
  overdue: ['Nothing overdue', 'Every to-do with a date is on time.'],
  questions: ['No open questions', 'Every question has been answered or resolved.'],
};

/** A calm "nothing here" for a choice: a check in a circle, a headline and one line. */
export function ItemsEmpty({ show }: { show: Show }) {
  const [title, line] = EMPTY[show];
  return <EmptyState icon="checks" title={title} line={line} />;
}
