import { useState } from 'react';
import { Link, useSearchParams } from 'react-router';
import { useQuery } from '@tanstack/react-query';
import { pageHref } from '@shared/markdown';
import type { SearchResponse } from '@shared/types';
import { api, errorMessage } from '../lib/api';
import { Icon, PageGlyph } from '../components/Icon';
import { Snippet } from '../components/Snippet';
import { SlideToggle } from '../components/charts';

/** Full search: semantic + keyword (hybrid) by default. */
export function SearchPage() {
  const [params, setParams] = useSearchParams();
  const q = params.get('q') ?? '';
  const mode = (params.get('mode') ?? 'hybrid') as SearchResponse['mode'];
  const [input, setInput] = useState(q);
  const res = useQuery({
    queryKey: ['search', q, mode],
    queryFn: () =>
      api.get<SearchResponse>(`/search?${new URLSearchParams({ q, mode, limit: '30' })}`),
    enabled: q.trim().length > 0,
    staleTime: 60_000,
  });

  const run = (next: { q?: string; mode?: string }) =>
    setParams({ q: next.q ?? q, mode: next.mode ?? mode });

  return (
    <div className="page search-page">
      <form
        className="search-form"
        onSubmit={(e) => {
          e.preventDefault();
          run({ q: input.trim() });
        }}
        role="search"
      >
        <Icon name="search" />
        <input
          value={input}
          onChange={(e) => setInput(e.target.value)}
          placeholder="Search by meaning or keywords"
          autoFocus
          aria-label="Search"
        />
        <button className="btn primary small" type="submit">
          Search
        </button>
      </form>
      <SlideToggle
        label="Search mode"
        value={mode}
        onChange={(m) => run({ mode: m })}
        options={[
          ['hybrid', 'Best match'],
          ['semantic', 'Meaning'],
          ['keyword', 'Exact words'],
        ]}
      />

      {res.data?.semantic_unavailable && <p className="banner">{res.data.semantic_unavailable}</p>}
      {res.isError && <p className="banner warn">{errorMessage(res.error)}</p>}
      {res.isFetching && !res.data && <p className="muted">Searching…</p>}
      {res.data && !res.data.hits.length && (
        <p className="muted">No pages match “{res.data.query}”.</p>
      )}
      <ol className="results">
        {res.data?.hits.map((h) => (
          <li key={h.id}>
            <Link to={pageHref(h.id, h.title)}>
              <div className="result-title">
                <PageGlyph icon={h.icon} folder={false} />
                <span>{h.title}</span>
                {h.source === 'semantic' && (
                  <span className="pill" title="Matched by meaning">
                    <Icon name="sparkle" size={12} /> meaning
                  </span>
                )}
              </div>
              {h.path.length > 0 && <div className="result-path">{h.path.join(' / ')}</div>}
              {h.snippet && <Snippet text={h.snippet} />}
            </Link>
          </li>
        ))}
      </ol>
    </div>
  );
}
