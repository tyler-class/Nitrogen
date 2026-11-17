// Open Items: every open to-do, question and reminder in the wiki, on its own page. Summary
// notifications ("Due today", "Overdue", "Open questions") open it on the matching tab, so they
// always land on a list of exactly what they were about. Items can be handled right here (see
// useOpenItems). Reminders are nudges: no checkbox, never overdue, gone once they've passed.
import { useSearchParams } from 'react-router';
import { todayKey } from '@shared/items';
import { ItemsEmpty, OpenItemsToggle, parseShow, showFilter } from '../components/OpenItemsFilter';
import { Icon } from '../components/Icon';
import { ItemRow } from '../components/ItemRow';
import { useOpenItems } from '../lib/useOpenItems';

export function OpenItems() {
  const [params, setParams] = useSearchParams();
  const show = parseShow(params.get('show'));
  const { q, live, all, idOf, rowProps } = useOpenItems();
  const today = todayKey();
  const list = all.filter(showFilter(today)[show]);

  return (
    <div className="page open-items-page">
      <h1 className="page-title view-title">
        <Icon name="checks" size={26} /> Open Items
      </h1>
      <OpenItemsToggle
        value={show}
        onChange={(s) => setParams(s === 'all' ? {} : { show: s }, { replace: true })}
        items={live}
        today={today}
      />
      {q.isPending ? (
        <p className="muted">Loading…</p>
      ) : list.length ? (
        <ul className="items-full">
          {list.map((i) => (
            <ItemRow key={idOf(i)} item={i} today={today} {...rowProps(i)} />
          ))}
        </ul>
      ) : (
        <ItemsEmpty show={show} />
      )}
    </div>
  );
}
