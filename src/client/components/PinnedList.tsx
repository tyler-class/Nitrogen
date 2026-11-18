// Home's Pinned list: drag a row by its handle to reorder (the empty slot shows, dashed, where it
// will land), × unpins it.
import { useState } from 'react';
import { Link } from 'react-router';
import {
  DndContext,
  DragOverlay,
  KeyboardSensor,
  PointerSensor,
  TouchSensor,
  closestCenter,
  useSensor,
  useSensors,
} from '@dnd-kit/core';
import {
  SortableContext,
  arrayMove,
  sortableKeyboardCoordinates,
  useSortable,
  verticalListSortingStrategy,
} from '@dnd-kit/sortable';
import { CSS } from '@dnd-kit/utilities';
import { pageHref } from '@shared/markdown';
import type { PageSummary } from '@shared/types';
import { Icon, PageGlyph } from './Icon';

function Row({
  page: p,
  onUnpin,
  overlay = false,
}: {
  page: PageSummary;
  onUnpin?(): void;
  overlay?: boolean;
}) {
  const s = useSortable({ id: p.id, disabled: overlay });
  return (
    <li
      ref={overlay ? undefined : s.setNodeRef}
      style={
        overlay
          ? undefined
          : { transform: CSS.Translate.toString(s.transform), transition: s.transition }
      }
      className={`pinned-row${s.isDragging && !overlay ? ' pinned-ph' : ''}${overlay ? ' pinned-overlay' : ''}`}
    >
      <button
        type="button"
        className="pinned-grip"
        aria-label={`Move ${p.title}`}
        title="Drag to reorder"
        {...(overlay ? {} : { ...s.attributes, ...s.listeners })}
      >
        <Icon name="grip" size={15} />
      </button>
      <Link to={pageHref(p.id, p.title)} draggable={false}>
        <PageGlyph icon={p.icon} folder={false} />
        <span className="dash-title">{p.title}</span>
      </Link>
      <button
        type="button"
        className="unpin"
        aria-label={`Unpin ${p.title}`}
        title="Unpin"
        onClick={onUnpin}
      >
        <Icon name="close" size={14} />
      </button>
    </li>
  );
}

export function PinnedList({
  pages,
  onReorder,
  onUnpin,
}: {
  pages: PageSummary[];
  onReorder(ids: string[]): void;
  onUnpin(p: PageSummary): void;
}) {
  const [active, setActive] = useState<string | null>(null);
  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 4 } }),
    // Phones: a short press on the handle starts the drag, so a swipe still scrolls.
    useSensor(TouchSensor, { activationConstraint: { delay: 150, tolerance: 6 } }),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates }),
  );
  const ids = pages.map((p) => p.id);
  const dragged = pages.find((p) => p.id === active);
  return (
    <DndContext
      sensors={sensors}
      collisionDetection={closestCenter}
      onDragStart={(e) => setActive(String(e.active.id))}
      onDragCancel={() => setActive(null)}
      onDragEnd={(e) => {
        setActive(null);
        const from = ids.indexOf(String(e.active.id));
        const to = e.over ? ids.indexOf(String(e.over.id)) : -1;
        if (from >= 0 && to >= 0 && from !== to) onReorder(arrayMove(ids, from, to));
      }}
    >
      <SortableContext items={ids} strategy={verticalListSortingStrategy}>
        <ul className="dash-list pinned-list">
          {pages.map((p) => (
            <Row key={p.id} page={p} onUnpin={() => onUnpin(p)} />
          ))}
        </ul>
      </SortableContext>
      {/* No drop animation: it slid back to where the row started before the new order showed. */}
      <DragOverlay dropAnimation={null}>
        {dragged ? <Row page={dragged} overlay /> : null}
      </DragOverlay>
    </DndContext>
  );
}
