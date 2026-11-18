// Tags in one line: as many as fit, then a "+N" pill that shows the rest in a small pop-out (on
// hover, or a tap on phones).
import { useLayoutEffect, useRef, useState } from 'react';
import { Link } from 'react-router';

const GAP = 6;
/** Room kept for the "+N" pill. */
const MORE_W = 46;

const chip = (t: string) => (
  <Link key={t} to={`/tags/${encodeURIComponent(t)}`} className="tag-chip">
    #{t}
  </Link>
);

export function FitTags({ tags }: { tags: string[] }) {
  const box = useRef<HTMLDivElement>(null);
  const measure = useRef<HTMLDivElement>(null);
  const [shown, setShown] = useState(tags.length);

  useLayoutEffect(() => {
    const el = box.current;
    const m = measure.current;
    if (!el || !m) return;
    const fit = () => {
      const cs = getComputedStyle(el);
      const room = el.clientWidth - parseFloat(cs.paddingLeft) - parseFloat(cs.paddingRight);
      const widths = [...m.children].map((c) => (c as HTMLElement).offsetWidth);
      let used = 0;
      let k = 0;
      for (; k < widths.length; k++) {
        const w = widths[k]! + (k ? GAP : 0);
        // Unless this is the last one, leave room for "+N" after it.
        const after = k < widths.length - 1 ? GAP + MORE_W : 0;
        if (used + w + after > room) break;
        used += w;
      }
      setShown(k);
    };
    fit();
    const ro = new ResizeObserver(fit);
    ro.observe(el);
    return () => ro.disconnect();
  }, [tags]);

  if (!tags.length) return null;
  const rest = tags.slice(shown);
  return (
    <div ref={box} className="fit-tags">
      {/* Every chip, invisible, to measure. */}
      <div ref={measure} className="fit-tags-measure" aria-hidden>
        {tags.map((t) => (
          <span key={t} className="tag-chip">
            #{t}
          </span>
        ))}
      </div>
      {tags.slice(0, shown).map(chip)}
      {rest.length > 0 && (
        <span className="fit-tags-more">
          <button type="button" className="tag-chip more" aria-label={`${rest.length} more tags`}>
            +{rest.length}
          </button>
          <span className="fit-tags-pop" role="list">
            {rest.map(chip)}
          </span>
        </span>
      )}
    </div>
  );
}
