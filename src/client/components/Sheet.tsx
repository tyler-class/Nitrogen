// A sheet that rises from the bottom on phones (drag the handle down to dismiss, up to expand)
// and opens as a centred dialog on wider screens. Same pattern as Ratio.
import { useEffect, useId, useRef, useState, type ReactNode } from 'react';
import { Icon } from './Icon';

export function Sheet({
  title,
  sub,
  onClose,
  children,
  footer,
  wide,
}: {
  title: ReactNode;
  sub?: ReactNode;
  onClose: () => void;
  children: ReactNode;
  footer?: ReactNode;
  /** A larger dialog on desktop (e.g. the graph). */
  wide?: boolean;
}) {
  const titleId = useId();
  const drag = useRef<{ y: number; t: number } | null>(null);
  const [dy, setDy] = useState(0);
  const [dragging, setDragging] = useState(false);
  const [expanded, setExpanded] = useState(false);
  const close = useRef(onClose);
  useEffect(() => {
    close.current = onClose;
  }, [onClose]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && close.current();
    document.addEventListener('keydown', onKey);
    const prev = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => {
      document.removeEventListener('keydown', onKey);
      document.body.style.overflow = prev;
    };
  }, []);

  const grab = {
    onPointerDown: (e: React.PointerEvent) => {
      if (window.matchMedia('(min-width: 640px)').matches) return;
      if ((e.target as HTMLElement).closest('button')) return;
      drag.current = { y: e.clientY, t: performance.now() };
      setDragging(true);
      try {
        (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
      } catch {
        /* best-effort */
      }
    },
    onPointerMove: (e: React.PointerEvent) => {
      if (!drag.current) return;
      const d = e.clientY - drag.current.y;
      setDy(d > 0 ? d : -Math.sqrt(-d) * 4);
    },
    onPointerUp: (e: React.PointerEvent) => {
      if (!drag.current) return;
      const d = e.clientY - drag.current.y;
      const speed = d / Math.max(1, performance.now() - drag.current.t);
      drag.current = null;
      setDragging(false);
      setDy(0);
      if (d > 120 || speed > 0.6) {
        if (expanded && d < 260 && speed <= 0.6) setExpanded(false);
        else onClose();
      } else if (d < -40) setExpanded(true);
    },
    onPointerCancel: () => {
      drag.current = null;
      setDragging(false);
      setDy(0);
    },
  };

  return (
    <div className="sheet-ov">
      <div
        className="sheet-scrim"
        style={{ opacity: dy > 0 ? Math.max(0.2, 1 - dy / 500) : 1 }}
        onClick={onClose}
      />
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        className={`sheet${expanded ? ' expanded' : ''}${wide ? ' wide' : ''}`}
        style={{
          transform: dy ? `translateY(${dy}px)` : undefined,
          transition: dragging ? 'none' : 'transform .22s ease, height .22s ease',
        }}
      >
        <div className="sh-grab" {...grab}>
          <div className="sh-handle" />
          <div className="sh-head">
            <div style={{ minWidth: 0 }}>
              <h2 id={titleId}>{title}</h2>
              {sub ? <div className="sh-sub">{sub}</div> : null}
            </div>
            <button type="button" className="sh-x" onClick={onClose} aria-label="Close">
              <Icon name="close" />
            </button>
          </div>
        </div>
        <div className="sh-body">{children}</div>
        {footer ? <div className="sh-foot">{footer}</div> : null}
      </div>
    </div>
  );
}
