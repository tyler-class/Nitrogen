// A board of panels the owner arranges: drag to reorder (handle on the left), half or full
// width, hide/show.
// Ported from Ratio. Order is live while dragging (the grid reflows; the dragged panel follows
// the pointer as an overlay). Half-width panels pack two to a row; the grid fills gaps densely.
import { useRef, useState, type ReactNode } from 'react';
import {
  DndContext,
  DragOverlay,
  KeyboardSensor,
  MeasuringStrategy,
  PointerSensor,
  pointerWithin,
  closestCenter,
  useSensor,
  useSensors,
  type CollisionDetection,
  type DragOverEvent,
} from '@dnd-kit/core';
import {
  SortableContext,
  arrayMove,
  rectSortingStrategy,
  sortableKeyboardCoordinates,
  useSortable,
} from '@dnd-kit/sortable';
import type { PanelLayout } from '@shared/types';
import { Icon } from './Icon';
import '../styles/panels.css';

export interface PanelDef {
  id: string;
  title: string;
  sub?: ReactNode;
  /** Default width; the owner can change it. */
  size: 'half' | 'full';
  /** Controls shown at the right of the header (e.g. a segmented toggle). */
  actions?: ReactNode;
  body: ReactNode;
}

/** Saved layout merged with the panels that exist: unknown ids dropped, new ones appended. */
function resolveLayout(defs: PanelDef[], saved: PanelLayout[]): PanelLayout[] {
  const known = new Set(defs.map((d) => d.id));
  const out = saved.filter((p) => known.has(p.id));
  const seen = new Set(out.map((p) => p.id));
  for (const d of defs) if (!seen.has(d.id)) out.push({ id: d.id, size: d.size, hidden: false });
  return out;
}

/** True (and restarts the clock) when at least 120 ms passed since the last reorder. */
function settled(last: { current: number }) {
  const t = performance.now();
  if (t - last.current < 120) return false;
  last.current = t;
  return true;
}

// Pointer first (stable with mixed sizes), nearest centre as the fallback for keyboard.
const collide: CollisionDetection = (args) => {
  const hits = pointerWithin(args);
  return hits.length ? hits : closestCenter(args);
};

export function PanelBoard({
  defs,
  saved,
  onSave,
}: {
  defs: PanelDef[];
  saved: PanelLayout[];
  onSave: (layout: PanelLayout[]) => void;
}) {
  // Local copy after the first change, so the screen never waits on the network.
  const [local, setLocal] = useState<PanelLayout[] | null>(null);
  const [activeId, setActiveId] = useState<string | null>(null);
  const lastMove = useRef(0);
  const layout = resolveLayout(defs, local ?? saved);
  const byId = new Map(defs.map((d) => [d.id, d]));
  const shown = layout.filter((p) => !p.hidden);
  const hidden = layout.filter((p) => p.hidden);

  const commit = (next: PanelLayout[]) => {
    setLocal(next);
    onSave(next);
  };
  const patch = (id: string, p: Partial<PanelLayout>) =>
    commit(layout.map((x) => (x.id === id ? { ...x, ...p } : x)));

  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 4 } }),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates }),
  );

  const onOver = ({ active, over }: DragOverEvent) => {
    if (!over || active.id === over.id) return;
    // Swapping panels of different sizes moves things under the pointer; a short pause
    // keeps it from flipping back and forth.
    if (!settled(lastMove)) return;
    const cur = local ?? layout;
    const from = cur.findIndex((p) => p.id === active.id);
    const to = cur.findIndex((p) => p.id === over.id);
    if (from < 0 || to < 0) return;
    setLocal(arrayMove(cur, from, to));
  };

  const active = activeId ? byId.get(activeId) : null;
  const activeSize = layout.find((p) => p.id === activeId)?.size;

  return (
    <div>
      <DndContext
        sensors={sensors}
        collisionDetection={collide}
        measuring={{ droppable: { strategy: MeasuringStrategy.Always } }}
        onDragStart={({ active: a }) => {
          setLocal(layout);
          setActiveId(String(a.id));
        }}
        onDragOver={onOver}
        onDragEnd={() => {
          setActiveId(null);
          if (local) onSave(resolveLayout(defs, local));
        }}
        onDragCancel={() => setActiveId(null)}
      >
        <SortableContext items={shown.map((p) => p.id)} strategy={rectSortingStrategy}>
          <div className="pn-wrap">
            <div className="pn-grid">
              {shown.map((p) => (
                <SortablePanel
                  key={p.id}
                  def={byId.get(p.id)!}
                  size={p.size}
                  dragging={activeId === p.id}
                  onSize={() => patch(p.id, { size: p.size === 'full' ? 'half' : 'full' })}
                  onHide={() => patch(p.id, { hidden: true })}
                />
              ))}
            </div>
          </div>
        </SortableContext>
        <DragOverlay dropAnimation={null}>
          {active && activeSize ? (
            <Panel def={active} size={activeSize} overlay>
              {active.body}
            </Panel>
          ) : null}
        </DragOverlay>
      </DndContext>

      {hidden.length > 0 && (
        <details className="pn-hidden">
          <summary>
            <Icon name="eyeOff" size={16} /> Hidden panels ({hidden.length})
          </summary>
          <div className="pn-hid-list">
            {hidden.map((p) => (
              <div className="pn-hid-row" key={p.id}>
                <span>{byId.get(p.id)!.title}</span>
                <button
                  type="button"
                  className="pn-tool"
                  aria-label={`Show ${byId.get(p.id)!.title}`}
                  title="Show"
                  onClick={() => {
                    // Back at the end of the board, where it is easy to find.
                    const rest = layout.filter((x) => x.id !== p.id);
                    commit([...rest, { ...p, hidden: false }]);
                  }}
                >
                  <Icon name="eye" size={17} />
                </button>
              </div>
            ))}
          </div>
        </details>
      )}
    </div>
  );
}

function SortablePanel({
  def,
  size,
  dragging,
  onSize,
  onHide,
}: {
  def: PanelDef;
  size: 'half' | 'full';
  dragging: boolean;
  onSize: () => void;
  onHide: () => void;
}) {
  const { attributes, listeners, setNodeRef, setActivatorNodeRef } = useSortable({ id: def.id });
  return (
    <Panel
      def={def}
      size={size}
      nodeRef={setNodeRef}
      placeholder={dragging}
      grip={
        <button
          type="button"
          className="pn-grip"
          aria-label={`Move ${def.title}`}
          ref={setActivatorNodeRef}
          {...attributes}
          {...listeners}
        >
          <Icon name="grip" size={17} />
        </button>
      }
      tools={
        <>
          <button
            type="button"
            className="pn-tool pn-size"
            onClick={onSize}
            title={size === 'full' ? 'Half width' : 'Full width'}
            aria-label={
              size === 'full' ? `Make ${def.title} half width` : `Make ${def.title} full width`
            }
          >
            <Icon name={size === 'full' ? 'colHalf' : 'colFull'} size={17} />
          </button>
          <button
            type="button"
            className="pn-tool"
            onClick={onHide}
            title="Hide"
            aria-label={`Hide ${def.title}`}
          >
            <Icon name="eye" size={17} />
          </button>
        </>
      }
    >
      {def.body}
    </Panel>
  );
}

function Panel({
  def,
  size,
  children,
  nodeRef,
  grip,
  tools,
  placeholder,
  overlay,
}: {
  def: PanelDef;
  size: 'half' | 'full';
  children: ReactNode;
  nodeRef?: (el: HTMLElement | null) => void;
  grip?: ReactNode;
  tools?: ReactNode;
  placeholder?: boolean;
  overlay?: boolean;
}) {
  return (
    <section
      ref={nodeRef}
      className={`pn${placeholder ? ' pn-ph' : ''}${overlay ? ' pn-overlay' : ''}`}
      data-size={size}
      aria-label={def.title}
    >
      {/* Handle on the left (as in Ratio), title, then width and hide on the right. */}
      <header className="pn-h">
        {grip ?? (
          <span className="pn-grip" aria-hidden>
            <Icon name="grip" size={17} />
          </span>
        )}
        <div className="pn-t">
          <h3>{def.title}</h3>
          {def.sub ? <div className="pn-sub">{def.sub}</div> : null}
        </div>
        {tools ? <div className="pn-tools">{tools}</div> : null}
      </header>
      {def.actions ? <div className="pn-actions">{def.actions}</div> : null}
      {children}
    </section>
  );
}
