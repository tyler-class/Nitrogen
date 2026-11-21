// A page's outline, the way docs and Notion do it: on the right edge of the page, a short column of
// dashes (one per heading, longer for bigger headings, the section you're reading darker). Hover
// it and the headings open in a card beside it, fading away when you move off; click it to pin
// them as an "On this page" column on the right (the page moves over if it needs the room), and
// the column's × hides it again (remembered on the device). On phones there's no hover: a button
// at the top of the page's body opens the list. Only there when the page has a heading.
import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import type { Heading } from '../lib/outline';
import { readLocal, writeLocal } from '../lib/storage';
import { Icon } from './Icon';

const PIN_KEY = 'n2.outline.pinned';
const canHover = () => window.matchMedia('(hover: hover) and (pointer: fine)').matches;
const wideScreen = () => window.matchMedia('(min-width: 861px)').matches;
/** How far down the screen a heading counts as the one you're reading. */
const READ_LINE = 140;

/** The heading you're reading: the last one whose top has passed the reading line. */
function useCurrent(headings: Heading[], topOf: (h: Heading) => number | null | undefined) {
  const [current, setCurrent] = useState(0);
  const latest = useRef({ headings, topOf });
  useLayoutEffect(() => {
    latest.current = { headings, topOf };
  });
  useEffect(() => {
    let frame = 0;
    const check = () => {
      frame = 0;
      const { headings: hs, topOf: top } = latest.current;
      let at = 0;
      for (let i = 0; i < hs.length; i++) {
        const y = top(hs[i]!);
        if (y != null && y <= READ_LINE) at = i;
      }
      setCurrent(at);
    };
    const on = () => {
      if (!frame) frame = requestAnimationFrame(check);
    };
    check();
    // The main column scrolls on wide screens, the window on phones: listen to both.
    document.addEventListener('scroll', on, { capture: true, passive: true });
    window.addEventListener('resize', on);
    return () => {
      cancelAnimationFrame(frame);
      document.removeEventListener('scroll', on, { capture: true });
      window.removeEventListener('resize', on);
    };
  }, [headings.length]);
  return current;
}

export function Outline({
  headings,
  onGo,
  topOf,
  onPinned,
  place = 'page',
}: {
  headings: Heading[];
  onGo: (h: Heading) => void;
  /** Where a heading is on screen now (px from the top of the window). */
  topOf: (h: Heading) => number | null | undefined;
  /** Tells the page when the outline is pinned beside it, so it can make room. */
  onPinned?: (pinned: boolean) => void;
  /**
   * Where this one is drawn: 'title' (the phone button, at the right of the title row) or
   * 'page' (the wide-screen dashes and column). Each draws nothing on the other kind of screen.
   */
  place?: 'title' | 'page';
}) {
  const [pinned, setPinned] = useState(() => readLocal(PIN_KEY, false));
  const [peek, setPeek] = useState(false);
  const [wide, setWide] = useState(wideScreen);
  const leaveTimer = useRef<number | undefined>(undefined);
  const root = useRef<HTMLDivElement>(null);
  // Just closed with ×: the pointer is sitting on the dashes, so hovering them doesn't reopen the
  // card until the pointer has left them once.
  const hush = useRef(false);
  // The pinned column slides away after × (still drawn for that moment).
  const [leaving, setLeaving] = useState(false);
  const leavingTimer = useRef<number | undefined>(undefined);
  const has = headings.length > 0;
  const isPinned = has && pinned && wide;
  const current = useCurrent(headings, topOf);

  useEffect(() => {
    const mq = window.matchMedia('(min-width: 861px)');
    const on = () => setWide(mq.matches);
    mq.addEventListener('change', on);
    return () => mq.removeEventListener('change', on);
  }, []);
  useEffect(() => onPinned?.(isPinned), [isPinned, onPinned]);
  // The dashes and the pinned column share one anchor: level with the top of the page's title,
  // following it up as you scroll until they meet the bar at the top, then staying there.
  useLayoutEffect(() => {
    // On the document, so the column sliding away after × still has it too.
    const el = document.documentElement;
    const title = document.querySelector('.main .page-title-row');
    if (!title || !wide || !has || place === 'title') return;
    let frame = 0;
    const anchor = () => {
      frame = 0;
      el.style.setProperty('--ol-top', `${Math.max(64, title.getBoundingClientRect().top)}px`);
    };
    const on = () => {
      if (!frame) frame = requestAnimationFrame(anchor);
    };
    anchor();
    document.addEventListener('scroll', on, { capture: true, passive: true });
    window.addEventListener('resize', on);
    return () => {
      cancelAnimationFrame(frame);
      document.removeEventListener('scroll', on, { capture: true });
      window.removeEventListener('resize', on);
      el.style.removeProperty('--ol-top');
    };
  }, [wide, isPinned, has, place]);
  useEffect(
    () => () => {
      window.clearTimeout(leaveTimer.current);
      window.clearTimeout(leavingTimer.current);
    },
    [],
  );
  // Phones (and any narrow window): a tap or click anywhere outside the pop-out closes it.
  useEffect(() => {
    if (!peek || wide) return;
    const away = (e: PointerEvent) => {
      if (!root.current?.contains(e.target as Node)) setPeek(false);
    };
    document.addEventListener('pointerdown', away);
    return () => document.removeEventListener('pointerdown', away);
  }, [peek, wide]);

  if (!has || (place === 'title') === wide) return null;

  const enter = () => {
    if (!canHover() || hush.current) return;
    window.clearTimeout(leaveTimer.current);
    setPeek(true);
  };
  const leave = () => {
    hush.current = false;
    if (!canHover()) return;
    // A moment's grace, so moving from the dashes to the card doesn't close it.
    window.clearTimeout(leaveTimer.current);
    leaveTimer.current = window.setTimeout(() => setPeek(false), 240);
  };
  const pin = (on: boolean) => {
    setPinned(on);
    writeLocal(PIN_KEY, on);
    setPeek(false);
    window.clearTimeout(leavingTimer.current);
    if (on) return setLeaving(false);
    hush.current = true;
    setLeaving(true);
    leavingTimer.current = window.setTimeout(() => setLeaving(false), 280);
  };
  const go = (h: Heading) => {
    onGo(h);
    if (!isPinned && !canHover()) setPeek(false);
  };
  // Indented from the page's top heading level: a page that starts at ## isn't pushed in.
  const top = Math.min(...headings.map((h) => h.level));
  const list = (
    <ul>
      {headings.map((h, i) => (
        <li key={`${h.line}-${h.id}`} className={`ol-${h.level - top + 1}`}>
          <button
            type="button"
            aria-current={i === current ? 'location' : undefined}
            onClick={() => go(h)}
          >
            {h.text}
          </button>
        </li>
      ))}
    </ul>
  );

  if (!wide)
    return (
      <div className="outline-m" ref={root}>
        <button
          type="button"
          className="btn icon-only outline-m-btn"
          aria-expanded={peek}
          aria-controls="page-outline"
          aria-label="Outline"
          onClick={() => setPeek((p) => !p)}
        >
          <Icon name="outline" size={17} />
        </button>
        <nav
          id="page-outline"
          aria-label="On this page"
          className={`outline-card${peek ? ' open' : ''}`}
          inert={!peek}
        >
          <div className="outline-col-h">
            <span>On this page</span>
            <button
              type="button"
              className="outline-x"
              onClick={() => setPeek(false)}
              aria-label="Close outline"
            >
              <Icon name="close" size={16} />
            </button>
          </div>
          {list}
        </nav>
      </div>
    );

  // On wide screens the outline lives outside the page (in <body>), so it stays pinned to the
  // window's right edge whatever the page does (it glides when the sidebar closes).
  const column = (gone: boolean) =>
    createPortal(
      <nav
        className={`outline-col${gone ? ' leaving' : ''}`}
        aria-label="On this page"
        ref={gone ? undefined : root}
        inert={gone}
      >
        <div className="outline-col-h">
          <span>On this page</span>
          <button
            type="button"
            className="outline-x"
            onClick={() => pin(false)}
            aria-label="Hide outline"
            title="Hide outline"
          >
            <Icon name="close" size={14} />
          </button>
        </div>
        {list}
      </nav>,
      document.body,
    );

  if (isPinned) return column(false);

  return createPortal(
    <>
      {leaving && column(true)}
      <div className="outline-dock" ref={root} onMouseEnter={enter} onMouseLeave={leave}>
        <button
          type="button"
          className="outline-dashes"
          onClick={() => pin(true)}
          onFocus={enter}
          aria-label="Outline (click to keep it open)"
          aria-expanded={peek}
          aria-controls="page-outline"
          title="Click to keep the outline open"
        >
          {/* Always the same three lines, whatever the page's headings. */}
          <i className="d-1" />
          <i className="d-2" />
          <i className="d-3" />
        </button>
        <nav
          id="page-outline"
          aria-label="Outline"
          className={`outline-card${peek ? ' open' : ''}`}
          inert={!peek}
          onBlur={(e) => !e.currentTarget.contains(e.relatedTarget as Node) && leave()}
        >
          <div className="outline-col-h">On this page</div>
          {list}
        </nav>
      </div>
    </>,
    document.body,
  );
}
