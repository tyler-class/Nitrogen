// Archived pages: out of the tree, search, open items and assistants' view, kept here until
// they're restored or deleted. Each archived branch is one row (its top page, with how many pages
// came with it).
import { useMemo, useState } from 'react';
import { Link } from 'react-router';
import { useQueryClient } from '@tanstack/react-query';
import { pageHref } from '@shared/markdown';
import { ancestorsOf } from '@shared/tree';
import type { PageSummary } from '@shared/types';
import { api, errorMessage } from '../lib/api';
import { keys, useDeletePage, useTree } from '../lib/queries';
import { Icon, PageGlyph } from '../components/Icon';
import { useToast } from '../components/Toast';
import { formatWhen } from './PageView';

interface Branch {
  page: PageSummary;
  /** Pages archived along with it. */
  inside: number;
  /** Where it was in the tree. */
  path: string[];
}

export function Archive() {
  const tree = useTree();
  const qc = useQueryClient();
  const toast = useToast();
  const del = useDeletePage();
  const [busy, setBusy] = useState<string | null>(null);

  const branches = useMemo<Branch[]>(() => {
    const archived = tree.data?.archived ?? [];
    const byId = new Map([...(tree.data?.pages ?? []), ...archived].map((p) => [p.id, p]));
    // The top of each branch: its parent isn't archived along with it.
    const tops = archived.filter((p) => {
      const parent = p.parent_id ? byId.get(p.parent_id) : undefined;
      return !parent || parent.archived_at !== p.archived_at;
    });
    return tops.map((page) => {
      let inside = 0;
      const walk = (id: string) =>
        archived
          .filter((c) => c.parent_id === id && c.archived_at === page.archived_at)
          .forEach((c) => {
            inside++;
            walk(c.id);
          });
      walk(page.id);
      return { page, inside, path: ancestorsOf(page.id, byId).map((a) => a.title) };
    });
  }, [tree.data]);

  const refresh = () =>
    Promise.all([
      qc.invalidateQueries({ queryKey: keys.tree }),
      qc.invalidateQueries({ queryKey: ['page'] }),
      qc.invalidateQueries({ queryKey: ['items'] }),
      qc.invalidateQueries({ queryKey: ['dashboard'] }),
    ]);

  async function restore(b: Branch) {
    setBusy(b.page.id);
    try {
      await api.post(`/pages/${b.page.id}/archive`, { archived: false });
      await refresh();
      toast(`Restored “${b.page.title}”.`);
    } catch (e) {
      toast(errorMessage(e));
    } finally {
      setBusy(null);
    }
  }

  async function remove(b: Branch) {
    if (
      !window.confirm(
        b.inside
          ? `Delete “${b.page.title}” and the ${b.inside} ${b.inside === 1 ? 'page' : 'pages'} inside it? This can’t be undone.`
          : `Delete “${b.page.title}”? This can’t be undone.`,
      )
    )
      return;
    setBusy(b.page.id);
    try {
      await del.mutateAsync(b.page.id);
      toast(`Deleted “${b.page.title}”.`);
    } catch (e) {
      toast(errorMessage(e));
    } finally {
      setBusy(null);
    }
  }

  return (
    <div className="page archive-page">
      <h1 className="page-title view-title">
        <Icon name="archive" size={26} /> Archive
      </h1>
      <p className="muted archive-sub">
        Out of the tree, search, action items and assistants’ view. Links to them still work.
      </p>
      {tree.isPending ? (
        <p className="muted">Loading…</p>
      ) : branches.length ? (
        <ul className="archive-list">
          {branches.map((b) => (
            <li key={b.page.id}>
              <Link to={pageHref(b.page.id, b.page.title)} className="archive-main">
                <PageGlyph icon={b.page.icon} folder={b.inside > 0} />
                <span className="archive-text">
                  <span className="archive-title">{b.page.title}</span>
                  <span className="muted archive-meta">
                    Archived {formatWhen(b.page.archived_at!)}
                    {b.inside > 0 && ` · ${b.inside} ${b.inside === 1 ? 'page' : 'pages'} inside`}
                    {b.path.length > 0 && ` · was in ${b.path.join(' › ')}`}
                  </span>
                </span>
              </Link>
              <div className="archive-actions">
                <button
                  className="btn small"
                  disabled={busy === b.page.id}
                  onClick={() => void restore(b)}
                >
                  <Icon name="unarchive" size={14} /> Restore
                </button>
                <button
                  className="btn small icon-only danger-hover"
                  disabled={busy === b.page.id}
                  onClick={() => void remove(b)}
                  aria-label={`Delete ${b.page.title}`}
                  title="Delete"
                >
                  <Icon name="trash" size={14} />
                </button>
              </div>
            </li>
          ))}
        </ul>
      ) : (
        <p className="muted items-empty">
          Nothing archived. Archive a page from its ⋯ menu to tidy it out of the way.
        </p>
      )}
    </div>
  );
}
