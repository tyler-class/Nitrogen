import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Link, useParams } from 'react-router';
import { pageHref } from '@shared/markdown';
import type { SearchResponse, TagCount } from '@shared/types';
import { api } from '../lib/api';
import { PageGlyph, Icon } from '../components/Icon';

export function Tags() {
  const { tag } = useParams<{ tag?: string }>();
  return tag ? <TagPages tag={tag} /> : <AllTags />;
}

function AllTags() {
  const q = useQuery({
    queryKey: ['tags'],
    queryFn: () => api.get<{ tags: TagCount[] }>('/tags'),
  });
  const [sort, setSort] = useState<'count' | 'name'>('count');
  const tags = [...(q.data?.tags ?? [])].sort((a, b) =>
    sort === 'name' ? a.tag.localeCompare(b.tag) : b.count - a.count || a.tag.localeCompare(b.tag),
  );
  return (
    <div className="page tags-page">
      <h1 className="page-title view-title">
        <Icon name="tag" size={26} /> Tags
      </h1>
      {q.data && !tags.length ? (
        <p className="muted">No tags yet. Add them under a page title, or write #tag in a page.</p>
      ) : (
        <>
          <div className="seg" role="radiogroup" aria-label="Sort">
            {(
              [
                ['count', 'Most used'],
                ['name', 'A–Z'],
              ] as const
            ).map(([k, label]) => (
              <button
                key={k}
                role="radio"
                aria-checked={sort === k}
                className={sort === k ? 'on' : ''}
                onClick={() => setSort(k)}
              >
                {label}
              </button>
            ))}
          </div>
          <div className="tag-cloud">
            {tags.map((t) => (
              <Link key={t.tag} to={`/tags/${encodeURIComponent(t.tag)}`} className="tag-chip">
                #{t.tag}
                <span className="count">{t.count}</span>
              </Link>
            ))}
          </div>
        </>
      )}
    </div>
  );
}

function TagPages({ tag }: { tag: string }) {
  const [filter, setFilter] = useState('');
  const q = useQuery({
    queryKey: ['tag', tag],
    queryFn: () =>
      api.get<SearchResponse>(`/search?${new URLSearchParams({ q: '', tag, limit: '50' })}`),
  });
  const hits = (q.data?.hits ?? []).filter((h) =>
    h.title.toLowerCase().includes(filter.trim().toLowerCase()),
  );
  return (
    <div className="page tags-page">
      <p className="crumbs">
        <Link to="/tags">Tags</Link>
      </p>
      <h1 className="page-title">#{tag}</h1>
      {(q.data?.hits.length ?? 0) > 8 && (
        <input
          className="tag-filter"
          value={filter}
          onChange={(e) => setFilter(e.target.value)}
          placeholder="Filter these pages"
          aria-label="Filter pages"
        />
      )}
      {q.data && !q.data.hits.length && <p className="muted">No pages have this tag.</p>}
      <ul className="dash-list">
        {hits.map((h) => (
          <li key={h.id}>
            <Link to={pageHref(h.id, h.title)}>
              <PageGlyph icon={h.icon} folder={false} />
              <span className="dash-title">{h.title}</span>
            </Link>
            {h.path.length > 0 && <span className="dash-meta">{h.path.join(' › ')}</span>}
          </li>
        ))}
      </ul>
    </div>
  );
}
