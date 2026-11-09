import { useEffect, useId, useRef, useState, type ReactNode } from 'react';
import { Icon } from './Icon';

/**
 * An "i" button with more detail in a popover: shown while a mouse hovers it, or kept open
 * by a tap or click until you tap elsewhere or press Escape.
 */
export function InfoTip({ label, children }: { label: string; children: ReactNode }) {
  const [pinned, setPinned] = useState(false);
  const [hover, setHover] = useState(false);
  const ref = useRef<HTMLSpanElement>(null);
  // Where the popover starts, relative to the icon, so it stays on screen wherever the icon is.
  const [offset, setOffset] = useState<number | null>(null);
  const place = () => {
    const r = ref.current?.getBoundingClientRect();
    if (!r) return;
    const w = Math.min(336, window.innerWidth - 40);
    // Prefer lining its right edge up with the icon; keep 16px from either screen edge.
    const left = Math.max(16, Math.min(r.right + 8 - w, window.innerWidth - 16 - w));
    setOffset(left - r.left);
  };
  const id = useId();
  const open = pinned || hover;
  useEffect(() => {
    if (!open) return;
    const close = () => {
      setPinned(false);
      setHover(false);
    };
    const away = (e: PointerEvent) => {
      if (!ref.current?.contains(e.target as Node)) close();
    };
    const esc = (e: KeyboardEvent) => {
      if (e.key === 'Escape') close();
    };
    document.addEventListener('pointerdown', away);
    document.addEventListener('keydown', esc);
    return () => {
      document.removeEventListener('pointerdown', away);
      document.removeEventListener('keydown', esc);
    };
  }, [open]);
  return (
    <span
      ref={ref}
      className="infotip"
      onPointerEnter={(e) => {
        if (e.pointerType !== 'mouse') return;
        place();
        setHover(true);
      }}
      onPointerLeave={(e) => e.pointerType === 'mouse' && setHover(false)}
    >
      <button
        type="button"
        aria-label={label}
        aria-expanded={open}
        aria-controls={id}
        className={open ? 'on' : ''}
        onClick={() => {
          place();
          setPinned((p) => !p);
        }}
      >
        <Icon name="info" size={15} />
      </button>
      {open && (
        // The top padding bridges the gap, so a mouse can move from the icon into it.
        <span
          id={id}
          role="note"
          className="infotip-pop"
          style={offset === null ? undefined : { left: offset, right: 'auto' }}
        >
          <span className="infotip-card">{children}</span>
        </span>
      )}
    </span>
  );
}

/** An on/off switch. */
export function Switch({
  on,
  onChange,
  label,
}: {
  on: boolean;
  onChange: (v: boolean) => void;
  label: string;
}) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={on}
      aria-label={label}
      className={`switch${on ? ' on' : ''}`}
      onClick={() => onChange(!on)}
    >
      <span />
    </button>
  );
}
