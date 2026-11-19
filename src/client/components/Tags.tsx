import { useState } from 'react';
import { Link } from 'react-router';
import { normalizeTag } from '@shared/markdown';
import { Icon } from './Icon';

/** Tags under a page title, linking to each tag's page. */
export function TagList({ tags }: { tags: string[] }) {
  if (!tags.length) return null;
  return (
    <div className="tag-row">
      {tags.map((t) => (
        <Link key={t} to={`/tags/${encodeURIComponent(t)}`} className="tag-chip">
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
}: {
  tags: string[];
  bodyTags: string[];
  onChange: (tags: string[]) => void;
}) {
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
          <Link to={`/tags/${encodeURIComponent(t)}`} className="tag-chip-link">
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
          className="tag-chip inline"
          title="Written as #tag in the page"
        >
          #{t}
        </Link>
      ))}
      {/* A dashed "+ Add tag" pill: tap in, type, then Enter (or tap away) makes the tag. */}
      <label className="tag-add">
        <Icon name="plus" size={12} />
        <input
          className="tag-input"
          size={Math.max(text.length + 1, 7)}
          value={text}
          placeholder="Add tag"
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
