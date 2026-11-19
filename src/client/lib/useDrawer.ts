// A drawer that opens and closes smoothly: its height is animated from where it is to where it's
// going (measured, so it works for any content), easing out. A tap mid-way turns it round from
// where it is. Phones' Safari animates a CSS grid row size unevenly; this doesn't.
import { useLayoutEffect, useRef } from 'react';

const EASE = 'cubic-bezier(0.2, 0.8, 0.2, 1)';

export function useDrawer<T extends HTMLElement>(open: boolean, duration = 280) {
  const ref = useRef<T>(null);
  const anim = useRef<Animation | null>(null);
  const first = useRef(true);
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const settle = () => {
      el.style.height = open ? '' : '0px';
      el.style.overflow = open ? '' : 'hidden';
    };
    if (first.current) {
      first.current = false;
      settle();
      return;
    }
    // From its height right now (part-way through a previous animation, perhaps).
    const from = el.getBoundingClientRect().height;
    anim.current?.cancel();
    if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) {
      settle();
      return;
    }
    el.style.height = 'auto';
    const to = open ? el.getBoundingClientRect().height : 0;
    el.style.overflow = 'hidden';
    el.style.height = `${to}px`;
    const a = el.animate([{ height: `${from}px` }, { height: `${to}px` }], {
      duration,
      easing: EASE,
    });
    anim.current = a;
    a.onfinish = () => {
      if (anim.current === a) settle();
    };
  }, [open, duration]);
  return ref;
}
