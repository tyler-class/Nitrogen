import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate } from '@tanstack/react-router';
import { useQueryClient } from '@tanstack/react-query';
import type { EditorView as CmView } from '@codemirror/view';
import { usePage, useTree, useVaultContext } from '../api/hooks.ts';
import { Markdown } from '../components/Markdown.tsx';
import { db, type Draft } from '../lib/db.ts';
import { saveDraft, flush, discardDraft, resolveConflict, setCommitListener, subscribeSync } from '../lib/sync.ts';
import { createEditor, insertSnippet, applyAutofix } from './cm.ts';
import { SNIPPETS, MERMAID_TEMPLATES } from './snippets.ts';
import { ImageDialog } from './ImageDialog.tsx';
import { TableBuilder } from './TableBuilder.tsx';
import { MergeView } from './MergeView.tsx';
import { Drawer } from '../components/Drawer.tsx';
import { toast } from '../lib/toast.ts';
import type { Diagnostic } from '@nitrogen/core';
import { useRail } from '../components/Shell.tsx';
import { ApiError } from '../api/client.ts';
import type { Mermaid as MermaidType } from '../components/Mermaid.tsx';

type Mode = 'source' | 'split' | 'preview';

export default function EditorView({ path }: { path: string }) {
  const page = usePage(path);
  const tree = useTree();
  const ctx = useVaultContext();
  const ctxRef = useRef(ctx);
  ctxRef.current = ctx;
  const navigate = useNavigate();
  const qc = useQueryClient();
  const host = useRef<HTMLDivElement>(null);
  const preview = useRef<HTMLDivElement>(null);
  const view = useRef<CmView | null>(null);
  const [doc, setDoc] = useState<string | null>(null);
  const [draft, setDraft] = useState<Draft | null | undefined>(undefined);
  const [mode, setMode] = useState<Mode>(() => (matchMedia('(max-width: 699px)').matches ? 'source' : 'split'));
  const [diags, setDiags] = useState<Diagnostic[]>([]);
  const [problemsOpen, setProblemsOpen] = useState(false);
  const [image, setImage] = useState<File | null>(null);
  const [tableOpen, setTableOpen] = useState(false);
  const [mermaidOpen, setMermaidOpen] = useState(false);
  const [dirty, setDirty] = useState(false);
  const saveTimer = useRef<ReturnType<typeof setTimeout>>(undefined);
  const isNew = page.isError && page.error instanceof ApiError && page.error.status === 404;
  // Latest known server version (updated by page loads and by our own commits).
  const server = useRef<{ sha: string | null; content: string | null }>({ sha: null, content: null });
  useEffect(() => {
    if (page.data && !server.current.sha) server.current = { sha: page.data.sha, content: page.data.content };
  }, [page.data]);
  useRail(null, []);

  // Load: local draft wins over the server copy.
  useEffect(() => {
    void db.drafts.get(path).then((d) => setDraft(d ?? null));
    return subscribeSync(() => void db.drafts.get(path).then((d) => setDraft(d ?? null)));
  }, [path]);
  const initial = draft ? draft.content : page.data?.content;
  const ready = draft !== undefined && (draft !== null || page.data !== undefined || isNew);

  const persist = useCallback(
    (content: string) => {
      setDirty(true);
      clearTimeout(saveTimer.current);
      saveTimer.current = setTimeout(async () => {
        const cur = await db.drafts.get(path);
        await saveDraft({
          path,
          op: 'put',
          content,
          baseSha: cur ? cur.baseSha : server.current.sha,
          base: cur ? cur.base : server.current.content,
        });
      }, 300);
    },
    [path],
  );

  const inConflict = draft?.status === 'conflict';
  // Create the editor once per page (and again after leaving the merge view). Draft status
  // changes after a commit must NOT rebuild it: that would reload stale content.
  useEffect(() => {
    if (!ready || !host.current || view.current || inConflict) return;
    const start = initial ?? `# ${tree.data?.pages.find((p) => p.path === path)?.title ?? 'Untitled'}\n\n`;
    setDoc(start);
    view.current = createEditor(host.current, {
      doc: start,
      path,
      getCtx: () => ctxRef.current,
      onChange: (d) => {
        setDoc(d);
        persist(d);
      },
      onSave: () => void save(),
      onScroll: (r) => {
        const p = preview.current;
        if (p) p.scrollTop = r * (p.scrollHeight - p.clientHeight);
      },
      onDiagnostics: setDiags,
    });
    view.current.focus();
    return () => {
      view.current?.destroy();
      view.current = null;
    };
  }, [ready, inConflict]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    document.documentElement.style.setProperty('--editor-font', `${localStorage.getItem('n2-editor-font') ?? '14'}px`);
    setCommitListener((paths, results) => {
      if (paths.includes(path)) {
        const sha = results.find((r) => r.path === path)?.sha ?? null;
        if (sha) server.current = { sha, content: view.current?.state.doc.toString() ?? server.current.content };
        setDirty(false);
        void qc.invalidateQueries({ queryKey: ['page', path] });
        void qc.invalidateQueries({ queryKey: ['tree'] });
      }
    });
    return () => {
      setCommitListener(null);
      // Leaving the editor commits.
      void flush();
    };
  }, [path, qc]);

  const save = async () => {
    clearTimeout(saveTimer.current);
    const content = view.current?.state.doc.toString();
    if (content !== undefined) {
      const fixed = applyAutofix(view.current!, ctxRef.current, path);
      const finalContent = view.current!.state.doc.toString();
      const cur = await db.drafts.get(path);
      if (cur || finalContent !== server.current.content)
        await saveDraft({ path, op: 'put', content: finalContent, baseSha: cur ? cur.baseSha : server.current.sha, base: cur ? cur.base : server.current.content });
      if (fixed) toast(`${fixed} fix${fixed === 1 ? '' : 'es'} applied (links, image options).`);
    }
    const errors = diags.filter((d) => d.severity === 'error');
    if (errors.length) toast(`${errors.length} lint error${errors.length === 1 ? '' : 's'}; saved anyway. Check Problems.`);
    await flush();
  };

  const done = async () => {
    await save();
    void navigate({ to: '/p/$', params: { _splat: path } });
  };

  const discard = async () => {
    if (!confirm('Discard your local changes to this page?')) return;
    await discardDraft(path);
    await qc.invalidateQueries({ queryKey: ['page', path] });
    void navigate({ to: '/p/$', params: { _splat: path } });
  };

  const insertImage = async (img: { path: string; b64: string; markdown: string }) => {
    await saveDraft({ path: img.path, op: 'put', content: '', contentB64: img.b64, baseSha: null, base: null });
    if (view.current) insertSnippet(view.current, `${img.markdown}$|`, undefined, undefined, true);
    setImage(null);
  };

  const tool = (id: string) => {
    const s = SNIPPETS.find((x) => x.id === id);
    if (s && view.current) insertSnippet(view.current, s.text, undefined, undefined, s.block);
  };

  const errors = diags.filter((d) => d.severity === 'error').length;
  const warnings = diags.length - errors;
  const assetsDir = tree.data?.config.assets_dir ?? 'images';

  const previewEl = useMemo(() => (doc !== null && mode !== 'source' ? <Markdown src={doc} path={path} ctx={ctx} /> : null), [doc, mode, path, ctx]);

  if (draft?.status === 'conflict')
    return (
      <MergeView
        base={draft.base ?? ''}
        mine={draft.content}
        theirs={draft.theirs ?? ''}
        onCancel={() => void discardDraft(path).then(() => navigate({ to: '/p/$', params: { _splat: path } }))}
        onResolve={(merged) => void resolveConflict(path, merged).then(() => setDraft({ ...draft, status: 'dirty', content: merged }))}
      />
    );
  if (!ready) return <div className="page"><div className="skeleton-line" /></div>;
  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100%' }}
      onDragOver={(e) => e.preventDefault()}
      onDrop={(e) => { const f = e.dataTransfer.files[0]; if (f?.type.startsWith('image/')) { e.preventDefault(); setImage(f); } }}
      onPaste={(e) => { const f = [...e.clipboardData.files].find((x) => x.type.startsWith('image/')); if (f) { e.preventDefault(); setImage(f); } }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '8px 12px', borderBottom: '1px solid var(--hairline)', flexWrap: 'wrap' }}>
        <strong style={{ marginRight: 4, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', maxWidth: '40vw' }}>{dirty || draft ? '● ' : ''}{tree.data?.pages.find((p) => p.path === path)?.title ?? path}</strong>
        <div role="tablist" aria-label="Editor mode" style={{ display: 'flex', border: '1px solid var(--hairline)', borderRadius: 8 }}>
          {(['source', 'split', 'preview'] as const).map((m) => (
            <button key={m} role="tab" aria-selected={mode === m} className="chip-toggle" aria-pressed={mode === m} style={{ border: 0 }} onClick={() => setMode(m)}>{{ source: 'Source', split: 'Split', preview: 'Preview' }[m]}</button>
          ))}
        </div>
        <button className="chip" onClick={() => setProblemsOpen(true)} aria-label={`${errors} errors, ${warnings} warnings`} style={{ color: errors ? 'var(--danger)' : undefined }}>
          {errors} errors · {warnings} warnings
        </button>
        <span style={{ flex: 1 }} />
        {draft && <button className="btn" onClick={() => void discard()}>Discard</button>}
        <button className="btn" onClick={() => void save()}>Save changes</button>
        <button className="btn btn-primary" onClick={() => void done()}>Done</button>
      </div>
      <div role="toolbar" aria-label="Insert" style={{ display: 'flex', gap: 2, padding: '4px 8px', borderBottom: '1px solid var(--hairline)', overflowX: 'auto', fontSize: 13 }}>
        {[['h2', 'H2'], ['list', 'List'], ['task', 'Task'], ['quote', 'Quote'], ['code', 'Code']].map(([id, l]) => <button key={id} className="btn" style={{ minHeight: 32, border: 0 }} onClick={() => tool(id!)}>{l}</button>)}
        <select className="btn" style={{ minHeight: 32, border: 0 }} aria-label="Insert callout" value="" onChange={(e) => { tool(e.target.value); e.currentTarget.value = ''; }}>
          <option value="">Callout…</option>
          {SNIPPETS.filter((s) => s.id.startsWith('callout-')).map((s) => <option key={s.id} value={s.id}>{s.label.replace('Callout: ', '')}</option>)}
        </select>
        <button className="btn" style={{ minHeight: 32, border: 0 }} onClick={() => tool('toggle')}>Toggle</button>
        <button className="btn" style={{ minHeight: 32, border: 0 }} onClick={() => tool('drawer')}>Drawer</button>
        <button className="btn" style={{ minHeight: 32, border: 0 }} onClick={() => setTableOpen(true)}>Table</button>
        <label className="btn" style={{ minHeight: 32, border: 0 }}>Image<input type="file" accept="image/*" hidden onChange={(e) => e.target.files?.[0] && setImage(e.target.files[0])} /></label>
        <button className="btn" style={{ minHeight: 32, border: 0 }} onClick={() => setMermaidOpen(true)}>Mermaid</button>
        <button className="btn" style={{ minHeight: 32, border: 0 }} onClick={() => view.current && insertSnippet(view.current, '[[$|')}>Link page</button>
      </div>
      <div style={{ flex: 1, display: 'grid', gridTemplateColumns: mode === 'split' ? '1fr 1fr' : '1fr', minHeight: 0 }}>
        <div ref={host} style={{ minHeight: 0, overflow: 'auto', display: mode === 'preview' ? 'none' : 'block', borderRight: mode === 'split' ? '1px solid var(--hairline)' : undefined }} />
        {mode !== 'source' && <div ref={preview} style={{ overflow: 'auto', padding: '16px 24px' }} aria-label="Preview">{previewEl}</div>}
      </div>
      {problemsOpen && (
        <Drawer title="Problems" width="sm" onClose={() => setProblemsOpen(false)}>
          <button className="btn" onClick={() => { const n = view.current ? applyAutofix(view.current, ctx, path) : 0; toast(n ? `${n} fixes applied.` : 'Nothing to autofix.'); }}>Autofix</button>
          {diags.length === 0 ? <p className="empty">No problems.</p> : (
            <ul className="list-plain">
              {diags.map((d, i) => (
                <li key={i} style={{ fontSize: 14 }}>
                  <button style={{ textAlign: 'left' }} onClick={() => { if (view.current && d.line > 0) { const l = view.current.state.doc.line(d.line); view.current.dispatch({ selection: { anchor: l.from }, scrollIntoView: true }); view.current.focus(); setProblemsOpen(false); } }}>
                    <strong style={{ color: d.severity === 'error' ? 'var(--danger)' : 'var(--warn)' }}>{d.code}</strong> {d.line > 0 && `line ${d.line}: `}{d.message} <span style={{ color: 'var(--muted)' }}>{d.fix}</span>
                  </button>
                </li>
              ))}
            </ul>
          )}
        </Drawer>
      )}
      {image && <ImageDialog file={image} assetsDir={assetsDir} maxPx={tree.data?.config.image_max_px ?? 2000} onClose={() => setImage(null)} onInsert={(i) => void insertImage(i)} />}
      {tableOpen && <TableBuilder onClose={() => setTableOpen(false)} onInsert={(md) => { if (view.current) insertSnippet(view.current, `${md}\n$|`, undefined, undefined, true); setTableOpen(false); }} />}
      {mermaidOpen && <MermaidPicker onClose={() => setMermaidOpen(false)} onInsert={(src) => { if (view.current) insertSnippet(view.current, `\`\`\`mermaid\n${src}\n\`\`\`\n$|`, undefined, undefined, true); setMermaidOpen(false); }} />}
    </div>
  );
}

function MermaidPicker({ onInsert, onClose }: { onInsert: (src: string) => void; onClose: () => void }) {
  const [name, setName] = useState(Object.keys(MERMAID_TEMPLATES)[0]!);
  const [src, setSrc] = useState(MERMAID_TEMPLATES[name]!);
  const [MermaidC, setM] = useState<null | typeof MermaidType>(null);
  useEffect(() => void import('../components/Mermaid.tsx').then((m) => setM(() => m.Mermaid)), []);
  return (
    <Drawer title="Mermaid diagram" width="lg" onClose={onClose}>
      <label>Template{' '}
        <select className="input" value={name} onChange={(e) => { setName(e.target.value); setSrc(MERMAID_TEMPLATES[e.target.value]!); }}>
          {Object.keys(MERMAID_TEMPLATES).map((k) => <option key={k}>{k}</option>)}
        </select>
      </label>
      <textarea className="input" style={{ fontFamily: 'var(--font-mono)', minHeight: 160, marginTop: 8 }} value={src} onChange={(e) => setSrc(e.target.value)} aria-label="Diagram source" />
      {MermaidC && <MermaidC source={src} />}
      <button className="btn btn-primary" onClick={() => onInsert(src)}>Insert diagram</button>
    </Drawer>
  );
}
