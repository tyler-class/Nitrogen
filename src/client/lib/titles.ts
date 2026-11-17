import { useMemo } from 'react';
import type { TitleIndex } from '../components/Markdown';
import { useTree } from './queries';

/** Page titles for resolving [[wikilinks]], and the list of titles. */
export function useTitleIndex(): { index: TitleIndex; titles: string[] } {
  const tree = useTree();
  return useMemo(() => {
    const index: TitleIndex = new Map();
    for (const p of tree.data?.pages ?? [])
      if (!index.has(p.title.toLowerCase())) index.set(p.title.toLowerCase(), p);
    // [[Links]] to archived pages still open them (shown muted); a live page with the title wins.
    for (const p of tree.data?.archived ?? [])
      if (!index.has(p.title.toLowerCase()))
        index.set(p.title.toLowerCase(), { id: p.id, title: p.title, archived: true });
    return { index, titles: [...new Set((tree.data?.pages ?? []).map((p) => p.title))].sort() };
  }, [tree.data]);
}
