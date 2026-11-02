import { useEffect, useMemo, useState } from 'react';
import { exportPages, normalize, summarizeLedger, type LedgerEntry, type Profile } from '@nitrogen/core';
import { zipSync, strToU8 } from 'fflate';
import { api, qs } from '../api/client.ts';
import { useVaultContext } from '../api/hooks.ts';
import { DiffBlock } from './History.tsx';
import { toast } from '../lib/toast.ts';

interface Bundle {
  pages: { path: string; sha: string; content: string }[];
  images: { path: string; sha: string | null }[];
  next: number | null;
  total: number;
}

async function fetchBundle(under: string): Promise<Bundle> {
  const all: Bundle = { pages: [], images: [], next: null, total: 0 };
  let cursor: number | null = 0;
  while (cursor !== null) {
    const b: Bundle = await api<Bundle>(`/bundle${qs({ under, cursor })}`);
    all.pages.push(...b.pages);
    all.images.push(...b.images);
    all.total = b.total;
    cursor = b.next;
  }
  return all;
}

function download(name: string, data: BlobPart, type: string) {
  const a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob([data], { type }));
  a.download = name;
  a.click();
}

/** Export as standard markdown: profile, frontmatter, diff preview, loss ledger, download or commit a copy. */
export default function ExportView({ path }: { path: string }) {
  const ctx = useVaultContext();
  const isPage = path.endsWith('.md');
  const [profile, setProfile] = useState<Profile>(() => (localStorage.getItem('n2-profile') as Profile) ?? 'gfm');
  const [fm, setFm] = useState<'keep' | 'strip' | 'inline'>(profile === 'gfm' ? 'keep' : 'inline');
  const [images, setImages] = useState(true);
  const [bundle, setBundle] = useState<Bundle | null>(null);
  const [busy, setBusy] = useState(false);
  useEffect(() => setFm(profile === 'gfm' ? 'keep' : 'inline'), [profile]);
  useEffect(() => {
    setBundle(null);
    void (isPage
      ? api<{ content: string; sha: string }>(`/page${qs({ path, include: 'content' })}`).then((p) => ({ pages: [{ path, sha: p.sha, content: p.content }], images: [], next: null, total: 1 }))
      : fetchBundle(path)
    ).then(setBundle, (e) => toast((e as Error).message));
  }, [path, isPage]);

  const result = useMemo(() => (bundle ? exportPages(bundle.pages, ctx, { profile, frontmatter: fm, includeImages: images }) : null), [bundle, ctx, profile, fm, images]);
  const single = isPage && bundle ? normalize(bundle.pages[0]!.content, profile, ctx, { path, frontmatter: fm }) : null;
  const ledger: LedgerEntry[] = result?.ledger.flatMap((l) => l.entries) ?? [];

  const zip = async () => {
    if (!result) return;
    setBusy(true);
    try {
      const files: Record<string, Uint8Array> = {};
      for (const f of result.files) files[f.path] = strToU8(f.content);
      for (const a of result.assets) {
        const res = await fetch(`/api/blob${qs({ path: a.from })}`);
        if (res.ok) files[a.to] = new Uint8Array(await res.arrayBuffer());
      }
      download(`${(path || 'wiki').replace(/\.md$/, '').replace(/[/]/g, '-') || 'wiki'}-${profile}.zip`, zipSync(files), 'application/zip');
    } finally {
      setBusy(false);
    }
  };

  const commitCopy = async () => {
    if (!result) return;
    setBusy(true);
    try {
      const changes = result.files.slice(0, 30).map((f) => ({ path: `_exports/${profile}/${f.path}`, op: 'put', content: f.content }));
      await api('/commit', { method: 'POST', json: { changes, message: `nitrogen: export ${path || 'wiki'} as ${profile}` } });
      toast(`Committed ${changes.length} file${changes.length === 1 ? '' : 's'} under /_exports/${profile}/.`);
    } catch (e) {
      toast((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="page wide">
      <h1 className="page-title">Export as standard markdown</h1>
      <p style={{ color: 'var(--muted)' }}>{isPage ? `/${path}` : `${bundle?.total ?? '…'} pages under /${path || ''}`}</p>
      <div className="toolbar">
        <label>Profile{' '}
          <select className="input" style={{ width: 'auto' }} value={profile} onChange={(e) => setProfile(e.target.value as Profile)}>
            <option value="gfm">GFM (GitHub, GitLab)</option>
            <option value="commonmark">Strict CommonMark</option>
          </select>
        </label>
        <label>Frontmatter{' '}
          <select className="input" style={{ width: 'auto' }} value={fm} onChange={(e) => setFm(e.target.value as typeof fm)}>
            <option value="keep">Keep</option><option value="strip">Strip</option><option value="inline">Inline as text</option>
          </select>
        </label>
        <label><input type="checkbox" checked={images} onChange={(e) => setImages(e.target.checked)} /> Include images</label>
      </div>
      <section aria-label="Loss ledger">
        <h2 style={{ fontSize: 18 }}>What changes</h2>
        {!result ? <div className="skeleton-line" /> : ledger.length === 0 ? <p>Nothing is lost: this content is already standard markdown.</p> : <pre style={{ fontSize: 13, whiteSpace: 'pre-wrap' }}>{summarizeLedger(ledger)}</pre>}
        <p style={{ fontSize: 13, color: 'var(--muted)' }}>Content, links, captions, relation types and table data are kept. Only display options (fold state, colors, icons, alignment, widths, drawer behavior) are dropped.</p>
      </section>
      {single && bundle && (
        <section>
          <h2 style={{ fontSize: 18 }}>Preview</h2>
          <DiffBlock before={bundle.pages[0]!.content} after={single.src} />
        </section>
      )}
      <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
        {single && <button className="btn btn-primary" onClick={() => download(path.split('/').pop()!, single.src, 'text/markdown')}>Download .md</button>}
        <button className={single ? 'btn' : 'btn btn-primary'} onClick={() => void zip()} disabled={!result || busy}>Download {isPage ? 'with images' : 'folder'} as .zip</button>
        <button className="btn" onClick={() => void commitCopy()} disabled={!result || busy}>Commit a copy to /_exports/{profile}/</button>
      </div>
    </div>
  );
}
