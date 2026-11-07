import { fileName, toPlainMarkdown } from '@shared/export';
import type { Backup, Page } from '@shared/types';
import { download, zip } from './zip';

/** One page as plain markdown, titled. */
export function downloadPage(page: Page) {
  const text = `# ${page.title}\n\n${toPlainMarkdown(page.body, { origin: location.origin })}\n`;
  download(new Blob([text], { type: 'text/markdown' }), `${fileName(page.title)}.md`);
}

/** Every page as plain markdown in folders that follow the tree, links rewritten to files. */
export function downloadAll(backup: Backup) {
  const byId = new Map(backup.pages.map((p) => [p.id, p]));
  const pathOf = new Map<string, string>();
  const used = new Set<string>();
  const folder = (p: Page): string => {
    const parts: string[] = [];
    let cur = p.parent_id ? byId.get(p.parent_id) : undefined;
    const seen = new Set<string>();
    while (cur && !seen.has(cur.id)) {
      seen.add(cur.id);
      parts.unshift(fileName(cur.title));
      cur = cur.parent_id ? byId.get(cur.parent_id) : undefined;
    }
    return parts.join('/');
  };
  for (const p of backup.pages) {
    const dir = folder(p);
    let name = `${dir ? `${dir}/` : ''}${fileName(p.title)}`;
    for (let n = 2; used.has(name.toLowerCase()); n++)
      name = `${dir ? `${dir}/` : ''}${fileName(p.title)} ${n}`;
    used.add(name.toLowerCase());
    pathOf.set(p.id, `${name}.md`);
  }
  const byTitle = new Map<string, string>();
  for (const p of [...backup.pages].sort((a, b) => a.created_at.localeCompare(b.created_at)))
    if (!byTitle.has(p.title.toLowerCase())) byTitle.set(p.title.toLowerCase(), p.id);
  const relative = (from: string, to: string) => {
    const a = from.split('/').slice(0, -1);
    const b = to.split('/');
    let i = 0;
    while (i < a.length && i < b.length - 1 && a[i] === b[i]) i++;
    return [...a.slice(i).map(() => '..'), ...b.slice(i)].join('/');
  };
  const files = backup.pages.map((p) => {
    const path = pathOf.get(p.id)!;
    const body = toPlainMarkdown(p.body, {
      origin: location.origin,
      link: (title) => {
        const id = byTitle.get(title.toLowerCase());
        return id ? relative(path, pathOf.get(id)!) : null;
      },
    });
    return { name: `Nitrogen/${path}`, text: `# ${p.title}\n\n${body}\n` };
  });
  download(zip(files), `nitrogen-markdown-${backup.exported_at.slice(0, 10)}.zip`);
}
