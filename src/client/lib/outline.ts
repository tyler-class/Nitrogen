// A page's headings, read from its markdown: what the outline lists and where each one jumps to.
import { slugify } from '@shared/markdown';

export interface Heading {
  /** 1, 2 or 3 (#, ## or ###). */
  level: number;
  /** The heading as the reader sees it. */
  text: string;
  /** Its anchor, as the renderer writes it (without the "h-" the sanitizer adds). */
  id: string;
  /** The line it's on, from 1 (for the editor). */
  line: number;
}

/** The heading's text as the reader sees it: links by their label, no markdown marks. */
function readable(raw: string): string {
  return raw
    .replace(
      /\[\[([^\]|#]+)(?:#([^\]|]+))?(?:\|([^\]]+))?\]\]/g,
      (_s, t: string, h?: string, label?: string) => label ?? (h ? `${t} › ${h}` : t),
    )
    .replace(/!?\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/==/g, '')
    .replace(/[*_`~]/g, '')
    .trim();
}

/**
 * Every heading in the page, in order, with the same anchors the renderer gives them (repeats get
 * -1, -2 …). Headings inside code blocks don't count. `maxLevel` keeps the outline to three levels;
 * deeper headings still count toward repeats so the anchors match.
 */
export function headingsOf(body: string, maxLevel = 6): Heading[] {
  const out: Heading[] = [];
  const seen = new Map<string, number>();
  let fence = false;
  const lines = body.split('\n');
  for (let i = 0; i < lines.length; i++) {
    const l = lines[i]!;
    if (/^\s*(```|~~~)/.test(l)) {
      fence = !fence;
      continue;
    }
    const m = fence ? null : /^(#{1,6})\s+(.*?)\s*#*\s*$/.exec(l);
    if (!m) continue;
    const text = readable(m[2]!);
    const base = slugify(text);
    const n = seen.get(base) ?? 0;
    seen.set(base, n + 1);
    const level = m[1]!.length;
    if (level <= maxLevel && text)
      out.push({ level, text, id: n ? `${base}-${n}` : base, line: i + 1 });
  }
  return out;
}

/** What scrolls the page: the main column on wide screens, the window on phones. */
function scroller(from: Element): HTMLElement | null {
  const main = from.closest<HTMLElement>('.main');
  return main &&
    main.scrollHeight > main.clientHeight &&
    getComputedStyle(main).overflowY !== 'visible'
    ? main
    : null;
}

/**
 * Glide the page so a point (px from the top of the window now) ends up just under the sticky
 * bar: quick, easing to a stop. Straight there when reduced motion is on.
 */
export function glideTo(from: Element, viewportY: number, margin = 72) {
  const el = scroller(from);
  const start = el ? el.scrollTop : window.scrollY;
  const top = el ? el.getBoundingClientRect().top : 0;
  const max = el
    ? el.scrollHeight - el.clientHeight
    : document.documentElement.scrollHeight - window.innerHeight;
  const end = Math.max(0, Math.min(max, start + viewportY - top - margin));
  const set = (y: number) => (el ? (el.scrollTop = y) : window.scrollTo(0, y));
  if (window.matchMedia('(prefers-reduced-motion: reduce)').matches || Math.abs(end - start) < 2)
    return set(end);
  const dist = end - start;
  // Longer jumps take a little longer, but never more than about half a second.
  const time = Math.min(520, 260 + Math.abs(dist) * 0.12);
  const t0 = performance.now();
  const ease = (t: number) => 1 - Math.pow(1 - t, 3);
  const step = (now: number) => {
    const t = Math.min(1, (now - t0) / time);
    set(start + dist * ease(t));
    if (t < 1) requestAnimationFrame(step);
  };
  requestAnimationFrame(step);
}
