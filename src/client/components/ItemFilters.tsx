// How a list of action items is shown: sort, group, and whether completed ones are listed. They
// sit behind one funnel button: on wide screens it opens a small pop-over beside it, on phones a
// sheet from the bottom, each choice a row of options.
import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from 'react';
import { Icon } from './Icon';
import { Sheet } from './Sheet';

export interface FilterChoice {
  /** "Sort", "Group by", "Completed". */
  label: string;
  value: string;
  options: readonly (readonly [string, string])[];
  onChange(value: string): void;
  /** The usual choice (the Filter button counts the others). */
  initial: string;
  /** Wide screens: an on/off pill instead of a dropdown (for Show/Hide completed). */
  toggle?: { on: string; off: string; labels: [string, string] };
}

const narrowQuery = '(max-width: 860px)';

function useNarrow() {
  const [narrow, setNarrow] = useState(() => window.matchMedia(narrowQuery).matches);
  useEffect(() => {
    const m = window.matchMedia(narrowQuery);
    const on = () => setNarrow(m.matches);
    m.addEventListener('change', on);
    return () => m.removeEventListener('change', on);
  }, []);
  return narrow;
}

export function ItemFilters({
  choices,
  title,
  onReset,
}: {
  choices: FilterChoice[];
  title: string;
  /** Put every choice back at once (when setting them one by one would overwrite each other). */
  onReset?(): void;
}) {
  const narrow = useNarrow();
  const [open, setOpen] = useState(false);
  const changed = choices.filter((c) => c.value !== c.initial).length;
  const btn = useRef<HTMLButtonElement>(null);

  return (
    <>
      <button
        ref={btn}
        type="button"
        className={`filter-btn${changed ? ' changed' : ''}`}
        aria-expanded={open}
        aria-haspopup="dialog"
        aria-label={changed ? `Filter (${changed} set)` : 'Filter'}
        title="Filter"
        onClick={() => setOpen(true)}
      >
        <Icon name="filter" size={18} />
        {changed > 0 && <span className="filter-count">{changed}</span>}
      </button>
      {open && !narrow && (
        <FilterPop anchor={btn} onClose={() => setOpen(false)}>
          <ResetLink choices={choices} onReset={onReset} />
          <Rows choices={choices} />
        </FilterPop>
      )}
      {open && narrow && (
        <Sheet
          title={
            <span className="filter-sheet-title">
              {title}
              <ResetLink choices={choices} onReset={onReset} />
            </span>
          }
          onClose={() => setOpen(false)}
        >
          <Rows choices={choices} />
        </Sheet>
      )}
    </>
  );
}

/** "Reset": every choice back to how it starts. Plain underlined text. */
function ResetLink({ choices, onReset }: { choices: FilterChoice[]; onReset?(): void }) {
  return (
    <button
      type="button"
      className="filter-reset"
      disabled={choices.every((c) => c.value === c.initial)}
      onClick={() => {
        if (onReset) onReset();
        else for (const c of choices) if (c.value !== c.initial) c.onChange(c.initial);
      }}
    >
      Reset
    </button>
  );
}

/** The choices as rows of options (the same in the pop-over and the sheet). */
function Rows({ choices }: { choices: FilterChoice[] }) {
  return (
    <div className="filter-rows">
      {choices.map((c) => (
        <div key={c.label} className="filter-row">
          <span className="filter-label">{c.label}</span>
          <div className="filter-opts" role="radiogroup" aria-label={c.label}>
            {c.options.map(([v, text]) => (
              <button
                key={v}
                type="button"
                role="radio"
                aria-checked={c.value === v}
                className={c.value === v ? 'on' : undefined}
                onClick={() => c.onChange(v)}
              >
                {text}
              </button>
            ))}
          </div>
        </div>
      ))}
    </div>
  );
}

/**
 * Wide screens: the choices in a small pop-over under the button, kept on screen. A click
 * outside it (or Escape) closes it.
 */
function FilterPop({
  anchor,
  onClose,
  children,
}: {
  anchor: React.RefObject<HTMLButtonElement | null>;
  onClose(): void;
  children: ReactNode;
}) {
  const box = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState<{ top: number; left: number } | null>(null);
  useLayoutEffect(() => {
    const place = () => {
      const r = anchor.current?.getBoundingClientRect();
      const w = box.current?.offsetWidth ?? 300;
      if (!r) return;
      // Line up with the button's left edge, or its right edge when it sits on the right.
      const want = r.left + r.width / 2 > window.innerWidth / 2 ? r.right - w : r.left;
      const left = Math.max(8, Math.min(want, window.innerWidth - 8 - w));
      setPos({ top: r.bottom + 8, left });
    };
    place();
    window.addEventListener('resize', place);
    window.addEventListener('scroll', place, true);
    return () => {
      window.removeEventListener('resize', place);
      window.removeEventListener('scroll', place, true);
    };
  }, [anchor]);
  useEffect(() => {
    const away = (e: PointerEvent) => {
      const t = e.target as Node;
      if (!box.current?.contains(t) && !anchor.current?.contains(t)) onClose();
    };
    const esc = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        onClose();
        anchor.current?.focus();
      }
    };
    document.addEventListener('pointerdown', away);
    document.addEventListener('keydown', esc);
    return () => {
      document.removeEventListener('pointerdown', away);
      document.removeEventListener('keydown', esc);
    };
  }, [anchor, onClose]);
  return (
    <div
      ref={box}
      className="filter-pop"
      role="dialog"
      aria-label="Filter"
      style={pos ? { top: pos.top, left: pos.left } : { visibility: 'hidden', top: 0, left: 0 }}
    >
      {children}
    </div>
  );
}
