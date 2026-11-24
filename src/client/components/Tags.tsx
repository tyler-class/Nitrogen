import { useState } from 'react';
import { Link, useLocation } from 'react-router';
import { normalizeTag } from '@shared/markdown';
import { Icon } from './Icon';

/** Where a tag's page was opened from (its back link goes there): a page's path and title. */
export interface TagFrom {
  href: string;
  title: string;
}

/** The link state that sends a tag page's back link to the page you're on. */
export function useTagFrom(title: string): { from: TagFrom } {
  const loc = useLocation();
  return { from: { href: loc.pathname + loc.search, title } };
}

/** Tags under a page title, linking to each tag's page. */
export function TagList({ tags, from }: { tags: string[]; from: string }) {
  const state = useTagFrom(from);
  if (!tags.length) return null;
  return (
    <div className="tag-row">
      {tags.map((t) => (
        <Link key={t} to={`/tags/${encodeURIComponent(t)}`} state={state} className="tag-chip">
          #{t}
        </Link>
      ))}
    </div>
  );
}

/** Edit a page's own tags. #tags written in the body are listed but changed in the text. */
export function TagEditor({
  tags,
  bodyTags,
  onChange,
  from,
}: {
  tags: string[];
  bodyTags: string[];
  onChange: (tags: string[]) => void;
  /** The page's title, for the tag page's back link. */
  from: string;
}) {
  const state = useTagFrom(from);
  const [text, setText] = useState('');
  const add = (raw: string) => {
    const next = raw
      .split(/[,\n]/)
      .map(normalizeTag)
      .filter((t) => t && !tags.includes(t));
    if (next.length) onChange([...tags, ...new Set(next)]);
    setText('');
  };
  const inline = bodyTags.filter((t) => !tags.includes(t));
  return (
    <div className="tag-row editing">
      {tags.map((t) => (
        <span key={t} className="tag-chip">
          <Link to={`/tags/${encodeURIComponent(t)}`} state={state} className="tag-chip-link">
            #{t}
          </Link>
          <button
            type="button"
            aria-label={`Remove tag ${t}`}
            onClick={() => onChange(tags.filter((x) => x !== t))}
          >
            ×
          </button>
        </span>
      ))}
      {inline.map((t) => (
        <Link
          key={t}
          to={`/tags/${encodeURIComponent(t)}`}
          state={state}
          className="tag-chip inline"
          title="Written as #tag in the page"
        >
          #{t}
        </Link>
      ))}
      {/* "+ Tag": tap in, type, then Enter (or tap away) makes the tag. */}
      <label className="tag-add">
        <Icon name="plus" size={12} />
        <input
          className="tag-input"
          size={Math.max(text.length + 1, 4)}
          value={text}
          placeholder="Tag"
          aria-label="Add a tag"
          onChange={(e) => {
            const v = e.target.value;
            if (/[,\n]/.test(v)) add(v);
            else setText(v);
          }}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && text.trim()) {
              e.preventDefault();
              add(text);
            } else if (e.key === 'Backspace' && !text && tags.length) onChange(tags.slice(0, -1));
          }}
          onBlur={() => text.trim() && add(text)}
        />
      </label>
    </div>
  );
}
