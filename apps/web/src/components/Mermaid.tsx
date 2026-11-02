import { useEffect, useId, useState } from 'react';
import { Drawer } from './Drawer.tsx';
import { Icon } from './Icon.tsx';

import type MermaidDefault from 'mermaid';

type MermaidApi = typeof MermaidDefault;
let loader: Promise<MermaidApi> | null = null;
let currentTheme = '';

function isDark(): boolean {
  const t = document.documentElement.dataset.theme;
  return t === 'dark' || (t !== 'light' && window.matchMedia?.('(prefers-color-scheme: dark)').matches);
}

async function load(): Promise<MermaidApi> {
  loader ??= import('mermaid').then((m) => m.default);
  const m = await loader;
  const theme = isDark() ? 'dark' : 'neutral';
  if (theme !== currentTheme) {
    m.initialize({ startOnLoad: false, securityLevel: 'strict', theme, fontFamily: 'var(--font-ui)' });
    currentTheme = theme;
  }
  return m;
}

/** Lazy-loaded, sandboxed mermaid diagram. Errors show the source and the parser message. */
export function Mermaid({ source, title, caption }: { source: string; title?: string; caption?: string }) {
  const id = `m${useId().replace(/[^a-zA-Z0-9]/g, '')}`;
  const [svg, setSvg] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [expanded, setExpanded] = useState(false);
  const [themeTick, setThemeTick] = useState(0);
  useEffect(() => {
    const mq = window.matchMedia?.('(prefers-color-scheme: dark)');
    const on = () => setThemeTick((t) => t + 1);
    mq?.addEventListener('change', on);
    window.addEventListener('n2:theme', on);
    return () => {
      mq?.removeEventListener('change', on);
      window.removeEventListener('n2:theme', on);
    };
  }, []);
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const m = await load();
        const { svg: out } = await m.render(`${id}-${themeTick}`, source);
        if (!cancelled) {
          setSvg(out);
          setError(null);
        }
      } catch (e) {
        if (!cancelled) setError((e as Error).message ?? String(e));
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [source, id, themeTick]);
  const download = () => {
    if (!svg) return;
    const a = document.createElement('a');
    a.href = URL.createObjectURL(new Blob([svg], { type: 'image/svg+xml' }));
    a.download = `${(title || 'diagram').replace(/[^a-z0-9-]+/gi, '-').toLowerCase()}.svg`;
    a.click();
  };
  return (
    <figure className="mermaid-block" aria-label={title || 'Diagram'}>
      <div className="mermaid-tools">
        {title && <span style={{ marginRight: 'auto', padding: '4px 8px', fontWeight: 600 }}>{title}</span>}
        <button className="icon-btn" aria-label="Copy diagram source" onClick={() => void navigator.clipboard?.writeText(source)}><Icon name="copy" size={14} /></button>
        <button className="icon-btn" aria-label="Expand diagram" onClick={() => setExpanded(true)} disabled={!svg}><Icon name="expand" size={14} /></button>
        <button className="icon-btn" aria-label="Download SVG" onClick={download} disabled={!svg}><Icon name="download" size={14} /></button>
      </div>
      {error ? (
        <div className="mermaid-error" role="alert">
          <p>Diagram error: {error}</p>
          <pre>{source}</pre>
        </div>
      ) : svg ? (
        <div className="mermaid-svg" dangerouslySetInnerHTML={{ __html: svg /* mermaid output with securityLevel strict (sanitized by mermaid/DOMPurify) */ }} />
      ) : (
        <div className="mermaid-svg"><div className="skeleton-line" style={{ height: 120 }} /></div>
      )}
      {caption && <figcaption style={{ fontSize: 13, color: 'var(--muted)', padding: '0 12px 8px' }}>{caption}</figcaption>}
      {expanded && svg && (
        <Drawer title={title || 'Diagram'} width="lg" onClose={() => setExpanded(false)}>
          <div className="mermaid-svg" dangerouslySetInnerHTML={{ __html: svg }} />
        </Drawer>
      )}
    </figure>
  );
}
