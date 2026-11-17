import { useEffect, useId, useRef, useState, type ReactNode } from 'react';
import { Icon } from './Icon';

/**
 * An "i" button with more detail in a popover: shown while a mouse hovers it, or kept open
 * by a tap or click until you tap elsewhere or press Escape.
 */
export function InfoTip({
  label,
  children,
  size = 15,
}: {
  label: string;
  children: ReactNode;
  /** The icon's size; the button grows with it. */
  size?: number;
}) {
  const [pinned, setPinned] = useState(false);
  const [hover, setHover] = useState(false);
  const ref = useRef<HTMLSpanElement>(null);
  // Where the popover sits on screen. It's fixed to the window (not the page), so the sidebar and
  // scrolling areas can't cover or clip it; it stays 16px from either edge of the window.
  const [pos, setPos] = useState<{ top: number; left: number } | null>(null);
  const place = () => {
    const r = ref.current?.getBoundingClientRect();
    if (!r) return;
    const w = Math.min(336, window.innerWidth - 40);
    // Prefer lining its right edge up with the icon.
    const left = Math.max(16, Math.min(r.right + 8 - w, window.innerWidth - 16 - w));
    setPos({ top: r.bottom, left });
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
    // Fixed to the window, so it follows the icon when the page scrolls or resizes.
    const follow = () => place();
    document.addEventListener('pointerdown', away);
    document.addEventListener('keydown', esc);
    window.addEventListener('scroll', follow, true);
    window.addEventListener('resize', follow);
    return () => {
      document.removeEventListener('pointerdown', away);
      document.removeEventListener('keydown', esc);
      window.removeEventListener('scroll', follow, true);
      window.removeEventListener('resize', follow);
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
        style={size !== 15 ? { width: size + 10, height: size + 10 } : undefined}
        onClick={() => {
          place();
          setPinned((p) => !p);
        }}
      >
        <Icon name="info" size={size} />
      </button>
      {open && (
        // The top padding bridges the gap, so a mouse can move from the icon into it.
        <span
          id={id}
          role="note"
          className="infotip-pop"
          style={pos ? { top: pos.top, left: pos.left } : undefined}
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
