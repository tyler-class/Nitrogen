// Phones and tablets: a sideways swipe never goes "back" (or forward) in Nitrogen. The only
// sideways swipe is the menu (Layout's useEdgeSwipe). Two layers:
//
// 1. A touch that starts at the very edge of the screen is claimed by the page, so iOS
//    Safari's edge swipe never starts. Taps on controls there still work.
// 2. A back/forward the system sends anyway (Android's back gesture, the installed app) is
//    undone before the router sees it. This file loads before the router, so its popstate
//    listener runs first. Desktop (fine pointers) keeps normal back and forward.

const touch = window.matchMedia('(pointer: coarse)');
const EDGE = 24;

document.addEventListener(
  'touchstart',
  (e) => {
    const t = e.touches[0];
    if (!touch.matches || !t || e.touches.length > 1 || !e.cancelable) return;
    if (t.clientX > EDGE && t.clientX < window.innerWidth - EDGE) return;
    const target = e.target as Element | null;
    if (
      target?.closest('a, button, input, textarea, select, label, [contenteditable], [role=button]')
    )
      return;
    e.preventDefault();
  },
  { passive: false, capture: true },
);

// React Router keeps the position in history as state.idx. Track it, so a pop's direction
// is known and can be reversed exactly.
type RouterState = { idx?: number } | null;
const idxOf = (s: unknown) => (s as RouterState)?.idx;
let current = idxOf(history.state);
for (const name of ['pushState', 'replaceState'] as const) {
  const original = history[name].bind(history);
  history[name] = (state: unknown, unused: string, url?: string | URL | null) => {
    original(state, unused, url);
    current = idxOf(state);
  };
}

let undoing = false;
window.addEventListener('popstate', (e) => {
  if (undoing) {
    // Our own history.go() landing back where we were: nothing for the router to do.
    undoing = false;
    e.stopImmediatePropagation();
    return;
  }
  const next = idxOf(history.state);
  if (!touch.matches || current === undefined || next === undefined || next === current) {
    current = next;
    return;
  }
  e.stopImmediatePropagation();
  undoing = true;
  history.go(current - next);
});
