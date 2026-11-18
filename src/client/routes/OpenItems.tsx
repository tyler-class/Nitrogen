// Open Items: every open to-do, question and reminder in the wiki, on its own page. Summary
// notifications ("Due today", "Overdue", "Open questions") open it on the matching tab, so they
// always land on a list of exactly what they were about. Items can be handled right here (see
// useOpenItems), listed as one list or grouped by page or by type. Reminders are nudges: no
// checkbox, never overdue, gone once they've passed.
import { useState } from 'react';
import { Link, useSearchParams } from 'react-router';
import { ITEM_TYPES, todayKey, type ItemType } from '@shared/items';
import { pageHref } from '@shared/markdown';
import type { OpenItem } from '@shared/types';
import { ItemsEmpty, OpenItemsToggle, parseShow, showFilter } from '../components/OpenItemsFilter';
import { Icon } from '../components/Icon';
import { ItemRow } from '../components/ItemRow';
import { MenuSelect } from '../components/MenuSelect';
import { useOpenItems } from '../lib/useOpenItems';
import { readLocal, writeLocal } from '../lib/storage';

const GROUPS = [
  ['none', 'None'],
  ['page', 'Document'],
  ['type', 'Type'],
] as const;
type Group = (typeof GROUPS)[number][0];
/** Group headings when grouped by type. */
const PLURALS: Record<ItemType, string> = {
  todo: 'To Dos',
  question: 'Questions',
  reminder: 'Reminders',
};
const parseGroup = (v: string | null): Group | null =>
  GROUPS.some(([g]) => g === v) ? (v as Group) : null;

interface Section {
  key: string;
  head: React.ReactNode;
  items: OpenItem[];
}

export function OpenItems() {
  const [params, setParams] = useSearchParams();
  const show = parseShow(params.get('show'));
  // The grouping is in the URL when chosen, and remembered on this device.
  const group =
    parseGroup(params.get('group')) ??
    parseGroup(readLocal<string>('n2.items.group', 'none')) ??
    'none';
  const { q, live, all, idOf, rowProps } = useOpenItems();
  const today = todayKey();
  const list = all.filter(showFilter(today)[show]);

  const setParam = (key: string, v: string | null) =>
    setParams(
      (p) => {
        const next = new URLSearchParams(p);
        if (v) next.set(key, v);
        else next.delete(key);
        return next;
      },
      { replace: true },
    );

  // In the list's own order (soonest first): pages by their first item; types in a fixed order.
  const sections: Section[] = [];
  if (group === 'page') {
    const byPage = new Map<string, OpenItem[]>();
    for (const i of list) byPage.set(i.page_id, [...(byPage.get(i.page_id) ?? []), i]);
    for (const [id, items] of byPage) {
      const p = items[0]!;
      sections.push({
        key: id,
        items,
        head: (
          <Link
            to={pageHref(id, p.page_title)}
            className="items-group-page"
            title={[...p.path, p.page_title].join(' › ')}
          >
            {p.page_icon && <span>{p.page_icon}</span>}
            <span className="items-group-title">{p.page_title}</span>
          </Link>
        ),
      });
    }
  } else if (group === 'type') {
    for (const t of ITEM_TYPES) {
      const items = list.filter((i) => i.type === t);
      if (items.length)
        sections.push({
          key: t,
          items,
          head: <span className={`item-chip item-${t}`}>{PLURALS[t]}</span>,
        });
    }
  }

  const rows = (items: OpenItem[]) =>
    items.map((i) => (
      <ItemRow
        key={idOf(i)}
        item={i}
        today={today}
        showPage={group !== 'page'}
        showType={group !== 'type'}
        {...rowProps(i)}
      />
    ));

  return (
    <div className="page open-items-page">
      <h1 className="page-title view-title">
        <Icon name="checks" size={26} /> Open Items
      </h1>
      <div className="open-items-controls">
        <OpenItemsToggle
          value={show}
          onChange={(s) => setParam('show', s === 'all' ? null : s)}
          items={live}
          today={today}
        />
        <MenuSelect
          label="Group by"
          value={group}
          options={GROUPS}
          onChange={(g) => {
            writeLocal('n2.items.group', g);
            setParam('group', g === 'none' ? null : g);
          }}
        />
      </div>
      {q.isPending ? (
        <p className="muted">Loading…</p>
      ) : !list.length ? (
        <ItemsEmpty show={show} />
      ) : group === 'none' ? (
        <ul className="items-full">{rows(list)}</ul>
      ) : (
        sections.map((s) => (
          <GroupCard
            key={`${group}:${s.key}`}
            id={`${group}:${s.key}`}
            head={s.head}
            count={s.items.length}
          >
            {rows(s.items)}
          </GroupCard>
        ))
      )}
    </div>
  );
}

/**
 * One group: the same collapsible card as a page's own Open Items box. A tap anywhere on its
 * heading row (except the page's link) opens or closes it; which are closed is remembered here.
 */
function GroupCard({
  id,
  head,
  count,
  children,
}: {
  id: string;
  head: React.ReactNode;
  count: number;
  children: React.ReactNode;
}) {
  const [open, setOpen] = useState(() => !readLocal<string[]>('n2.items.closed', []).includes(id));
  const toggle = () =>
    setOpen((o) => {
      const closed = readLocal<string[]>('n2.items.closed', []).filter((k) => k !== id);
      writeLocal('n2.items.closed', o ? [...closed, id] : closed);
      return !o;
    });
  const drawer = `group-${id.replace(/[^\w-]/g, '-')}`;
  return (
    <section className={`item-summary items-group${open ? ' open' : ''}`}>
      <h2 className="item-summary-title">
        <div
          className="items-group-head"
          onClick={(e) => {
            if (!(e.target as HTMLElement).closest('a, button')) toggle();
          }}
        >
          {head}
          <span className="count">{count}</span>
          <button
            type="button"
            className="item-summary-chev"
            aria-expanded={open}
            aria-controls={drawer}
            aria-label={open ? 'Collapse' : 'Expand'}
            onClick={toggle}
          >
            <Icon name="chevron" size={16} />
          </button>
        </div>
      </h2>
      <div className="item-summary-drawer" id={drawer} inert={!open}>
        <div className="item-summary-inner">
          <ul className="items-full">{children}</ul>
        </div>
      </div>
    </section>
  );
}
