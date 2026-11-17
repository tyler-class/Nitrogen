// Themed date and time pickers (the browsers' own differ by device and ignore the app's theme).
// Each is a button showing the value that opens a small pop-over: a month calendar for dates, a
// list of times in 15-minute steps for times. The pop-over is fixed to the window so scrolling
// areas can't clip it, and closes on Escape or a tap outside.
import {
  createContext,
  useContext,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type ReactNode,
} from 'react';
import { Icon } from './Icon';

const pad = (n: number) => String(n).padStart(2, '0');
const key = (y: number, m: number, d: number) => `${y}-${pad(m + 1)}-${pad(d)}`;
const todayKey = () => {
  const t = new Date();
  return key(t.getFullYear(), t.getMonth(), t.getDate());
};
const parse = (k: string) => {
  const [y, m, d] = k.split('-').map(Number);
  return { y: y!, m: m! - 1, d: d! };
};

/** "Tue, Nov 18" (with the year when it isn't this year). */
function dateLabel(k: string): string {
  const { y, m, d } = parse(k);
  return new Date(y, m, d).toLocaleDateString(undefined, {
    weekday: 'short',
    month: 'short',
    day: 'numeric',
    ...(y !== new Date().getFullYear() ? { year: 'numeric' } : {}),
  });
}

/** "14:30" → "2:30 PM". */
function timeLabel(t: string): string {
  const [h, m] = t.split(':').map(Number);
  return new Date(2000, 0, 1, h, m).toLocaleTimeString(undefined, {
    hour: 'numeric',
    minute: '2-digit',
  });
}

/** Closes the open pop-over (after a pick). */
const CloseCtx = createContext<() => void>(() => undefined);

/** A button and its pop-over, placed under it and kept on screen. */
function Pop({
  label,
  icon,
  text,
  muted,
  children,
}: {
  label: string;
  icon: string;
  text: string;
  muted?: boolean;
  children: ReactNode;
}) {
  const [open, setOpen] = useState(false);
  const [pos, setPos] = useState<{ top: number; left: number } | null>(null);
  const btn = useRef<HTMLButtonElement>(null);
  const pop = useRef<HTMLDivElement>(null);

  // Below the button, or above it when there's no room; never past the window's edges.
  useLayoutEffect(() => {
    if (!open) return;
    const place = () => {
      const r = btn.current?.getBoundingClientRect();
      const p = pop.current?.getBoundingClientRect();
      if (!r || !p) return;
      const left = Math.max(8, Math.min(r.left, window.innerWidth - 8 - p.width));
      const below = r.bottom + 6;
      const top =
        below + p.height > window.innerHeight - 8 && r.top - 6 - p.height > 8
          ? r.top - 6 - p.height
          : below;
      setPos({ top, left });
    };
    place();
    window.addEventListener('resize', place);
    window.addEventListener('scroll', place, true);
    return () => {
      window.removeEventListener('resize', place);
      window.removeEventListener('scroll', place, true);
    };
  }, [open]);

  useEffect(() => {
    if (!open) return;
    const away = (e: PointerEvent) => {
      const t = e.target as Node;
      if (!pop.current?.contains(t) && !btn.current?.contains(t)) setOpen(false);
    };
    const esc = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        setOpen(false);
        btn.current?.focus();
      }
    };
    document.addEventListener('pointerdown', away);
    document.addEventListener('keydown', esc);
    return () => {
      document.removeEventListener('pointerdown', away);
      document.removeEventListener('keydown', esc);
    };
  }, [open]);

  // After picking, focus goes back to the button (for keyboards): the pop-over asks for it, and
  // the effect does it once the pop-over is gone.
  const refocus = useRef(false);
  useEffect(() => {
    if (!open && refocus.current) {
      refocus.current = false;
      btn.current?.focus();
    }
  }, [open]);
  const close = () => {
    refocus.current = true;
    setOpen(false);
  };

  return (
    <>
      <button
        ref={btn}
        type="button"
        className={`dt-field${muted ? ' muted' : ''}`}
        aria-label={`${label}: ${text}`}
        aria-haspopup="dialog"
        aria-expanded={open}
        onClick={() => {
          setPos(null);
          setOpen((o) => !o);
        }}
      >
        <Icon name={icon} size={14} />
        {text}
      </button>
      {open && (
        <div
          ref={pop}
          className="dt-pop"
          role="dialog"
          aria-label={label}
          style={pos ? { top: pos.top, left: pos.left } : { visibility: 'hidden', top: 0, left: 0 }}
        >
          <CloseCtx.Provider value={close}>{children}</CloseCtx.Provider>
        </div>
      )}
    </>
  );
}

const WEEKDAYS = Array.from({ length: 7 }, (_, i) =>
  new Date(2026, 10, 1 + i).toLocaleDateString(undefined, { weekday: 'narrow' }),
); // Nov 1, 2026 is a Sunday.

/** A date as YYYY-MM-DD, picked from a month calendar. */
export function DatePicker({
  value,
  onChange,
  label = 'Date',
}: {
  value: string;
  onChange: (v: string) => void;
  label?: string;
}) {
  return (
    <Pop label={label} icon="calendar" text={dateLabel(value)}>
      <Calendar value={value} onPick={onChange} />
    </Pop>
  );
}

function Calendar({ value, onPick: pick }: { value: string; onPick: (v: string) => void }) {
  const close = useContext(CloseCtx);
  const onPick = (v: string) => {
    pick(v);
    close();
  };
  const sel = parse(value);
  const [view, setView] = useState({ y: sel.y, m: sel.m });
  const today = todayKey();
  const first = new Date(view.y, view.m, 1).getDay();
  const days = new Date(view.y, view.m + 1, 0).getDate();
  const cells: (number | null)[] = [
    ...Array.from({ length: first }, () => null),
    ...Array.from({ length: days }, (_, i) => i + 1),
  ];
  const move = (n: number) =>
    setView((v) => {
      const d = new Date(v.y, v.m + n, 1);
      return { y: d.getFullYear(), m: d.getMonth() };
    });
  const title = new Date(view.y, view.m, 1).toLocaleDateString(undefined, {
    month: 'long',
    year: 'numeric',
  });

  return (
    <div className="cal">
      <div className="cal-head">
        <button
          type="button"
          className="cal-nav"
          onClick={() => move(-1)}
          aria-label="Previous month"
        >
          <Icon name="chevron" size={16} />
        </button>
        <span className="cal-title" aria-live="polite">
          {title}
        </span>
        <button
          type="button"
          className="cal-nav next"
          onClick={() => move(1)}
          aria-label="Next month"
        >
          <Icon name="chevron" size={16} />
        </button>
      </div>
      <div className="cal-grid" role="grid">
        {WEEKDAYS.map((w, i) => (
          <span key={i} className="cal-dow" aria-hidden>
            {w}
          </span>
        ))}
        {cells.map((d, i) => {
          if (d === null) return <span key={`x${i}`} />;
          const k = key(view.y, view.m, d);
          return (
            <button
              key={k}
              type="button"
              className={`cal-day${k === value ? ' on' : ''}${k === today ? ' today' : ''}`}
              aria-label={dateLabel(k)}
              aria-pressed={k === value}
              onClick={() => onPick(k)}
            >
              {d}
            </button>
          );
        })}
      </div>
      <div className="cal-foot">
        <button type="button" className="cal-today" onClick={() => onPick(today)}>
          Today
        </button>
      </div>
    </div>
  );
}

const TIMES = Array.from(
  { length: 96 },
  (_, i) => `${pad(Math.floor(i / 4))}:${pad((i % 4) * 15)}`,
);

/** A time as "HH:MM" (or "" for none), picked from a list in 15-minute steps. */
export function TimePicker({
  value,
  onChange,
  label = 'Time',
  allowNone = true,
}: {
  value: string;
  onChange: (v: string) => void;
  label?: string;
  allowNone?: boolean;
}) {
  return (
    <Pop label={label} icon="clock" text={value ? timeLabel(value) : 'No time'} muted={!value}>
      <TimeList value={value} allowNone={allowNone} onPick={onChange} />
    </Pop>
  );
}

function TimeList({
  value,
  allowNone,
  onPick: pick,
}: {
  value: string;
  allowNone: boolean;
  onPick: (v: string) => void;
}) {
  const close = useContext(CloseCtx);
  const onPick = (v: string) => {
    pick(v);
    close();
  };
  const list = useRef<HTMLDivElement>(null);
  // A time that isn't on a quarter hour (typed on the page) is listed too.
  const times = value && !TIMES.includes(value) ? [...TIMES, value].sort() : TIMES;
  // Open on the chosen time, or around 9 a.m.
  useLayoutEffect(() => {
    const el = list.current?.querySelector<HTMLElement>(
      value ? '.time-opt.on' : '[data-time="09:00"]',
    );
    if (el && list.current) list.current.scrollTop = el.offsetTop - list.current.clientHeight / 3;
  }, [value]);
  return (
    <div className="time-list" ref={list} role="listbox" aria-label="Times">
      {allowNone && (
        <button
          type="button"
          role="option"
          aria-selected={!value}
          className={`time-opt none${!value ? ' on' : ''}`}
          onClick={() => onPick('')}
        >
          No time
        </button>
      )}
      {times.map((t) => (
        <button
          key={t}
          type="button"
          role="option"
          data-time={t}
          aria-selected={t === value}
          className={`time-opt${t === value ? ' on' : ''}`}
          onClick={() => onPick(t)}
        >
          {timeLabel(t)}
        </button>
      ))}
    </div>
  );
}
