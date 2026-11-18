// A themed dropdown: a pill showing the choice, opening a small list in the app's menu style.
import { useEffect, useRef, useState } from 'react';
import { Icon } from './Icon';

export function MenuSelect<T extends string>({
  label,
  value,
  options,
  onChange,
}: {
  /** Shown before the choice ("Group by"). */
  label: string;
  value: T;
  options: readonly (readonly [T, string])[];
  onChange(v: T): void;
}) {
  const [open, setOpen] = useState(false);
  const box = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const away = (e: PointerEvent) => {
      if (!box.current?.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener('pointerdown', away);
    return () => document.removeEventListener('pointerdown', away);
  }, [open]);
  const current = options.find(([v]) => v === value)?.[1] ?? value;
  return (
    <div
      ref={box}
      className="menu-select"
      onKeyDown={(e) => {
        if (e.key === 'Escape' && open) {
          e.stopPropagation();
          setOpen(false);
        } else if (open && (e.key === 'ArrowDown' || e.key === 'ArrowUp')) {
          e.preventDefault();
          const opts = [
            ...(box.current?.querySelectorAll<HTMLButtonElement>('[role=option]') ?? []),
          ];
          const at = opts.indexOf(document.activeElement as HTMLButtonElement);
          const next = e.key === 'ArrowDown' ? at + 1 : at - 1;
          opts[(next + opts.length) % opts.length]?.focus();
        }
      }}
    >
      <button
        type="button"
        className="menu-select-btn"
        aria-haspopup="listbox"
        aria-expanded={open}
        onClick={() => setOpen((o) => !o)}
      >
        <span className="menu-select-label">{label}</span> {current}
        <Icon name="chevron" size={14} />
      </button>
      {open && (
        <div className="menu menu-select-list" role="listbox" aria-label={label}>
          {options.map(([v, text]) => (
            <button
              key={v}
              type="button"
              role="option"
              aria-selected={v === value}
              autoFocus={v === value}
              onClick={() => {
                onChange(v);
                setOpen(false);
              }}
            >
              {text}
              {v === value && <Icon name="check" size={14} />}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
