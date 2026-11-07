// ```mermaid code blocks rendered as diagrams. Mermaid is large, so it loads only when a page
// has a diagram. securityLevel "strict" keeps diagrams from running scripts or raw HTML.
import { useEffect, useId, useState } from 'react';

let loading: Promise<typeof import('mermaid').default> | null = null;
let themed: string | null = null;

function isDark() {
  const t = document.documentElement.dataset.theme;
  return t ? t === 'dark' : window.matchMedia('(prefers-color-scheme: dark)').matches;
}

async function mermaid() {
  loading ??= import('mermaid').then((m) => m.default);
  const m = await loading;
  const theme = isDark() ? 'dark' : 'neutral';
  if (themed !== theme) {
    m.initialize({
      startOnLoad: false,
      securityLevel: 'strict',
      theme,
      fontFamily: getComputedStyle(document.body).fontFamily,
    });
    themed = theme;
  }
  return m;
}

export function Mermaid({ code }: { code: string }) {
  const id = `mmd-${useId().replace(/[^a-zA-Z0-9]/g, '')}`;
  const [svg, setSvg] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let live = true;
    mermaid()
      .then((m) => m.render(id, code))
      .then(({ svg }) => live && (setSvg(svg), setError(null)))
      .catch((e: unknown) => {
        document.getElementById(`d${id}`)?.remove(); // mermaid leaves an error node behind
        if (live) setError(e instanceof Error ? e.message : String(e));
      });
    return () => {
      live = false;
    };
  }, [code, id]);

  if (error)
    return (
      <div className="mermaid-error" role="note">
        <strong>This diagram has a syntax error.</strong>
        <span>{error.split('\n')[0]}</span>
        <pre>
          <code>{code}</code>
        </pre>
      </div>
    );
  if (!svg) return <div className="mermaid-box loading" aria-busy="true" />;
  // Mermaid's own output, sanitized by its strict mode.
  return <div className="mermaid-box" dangerouslySetInnerHTML={{ __html: svg }} />;
}
