// Changes to one typed item, made where it's written (one line of its page).
import type { Page } from '@shared/types';
import { api } from './api';

/**
 * Delete the item on `line` of a page. Returns the saved page and an undo that puts the line
 * back (as long as nobody changed the page in the meantime).
 */
export async function deleteItem(
  pageId: string,
  line: number,
): Promise<{ page: Page; undo(): Promise<Page> }> {
  const res = await api.post<Page & { removed: string }>(`/pages/${pageId}/items/delete`, {
    line,
  });
  const { removed, ...page } = res;
  return {
    page,
    undo: () => {
      const lines = page.body.split('\n');
      lines.splice(line - 1, 0, removed);
      return api.patch<Page>(`/pages/${pageId}`, {
        body: lines.join('\n'),
        base_version: page.version,
      });
    },
  };
}
