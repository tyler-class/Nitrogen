// ```mermaid code blocks rendered as diagrams. Mermaid is large, so it loads only when a page
// has a diagram. securityLevel "strict" keeps diagrams from running scripts or raw HTML.
import { useEffect, useId, useState } from 'react';

let loading: Promise<typeof import('mermaid').default> | null = null;
let themed: string | null = null;

function isDark() {
  const t = document.documentElement.dataset.theme;
  return t ? t === 'dark' : window.matchMedia('(prefers-color-scheme: dark)').matches;
}

/** Nitrogen's own colours, read from the CSS tokens so diagrams follow the theme. */
function themeVariables(dark: boolean) {
  const css = getComputedStyle(document.documentElement);
  const v = (name: string) => css.getPropertyValue(name).trim();
  return {
    darkMode: dark,
    fontFamily: getComputedStyle(document.body).fontFamily,
    fontSize: '14px',
    background: v('--paper'),
    textColor: v('--ink'),
    lineColor: v('--muted'),
    // Boxes: soft accent fill, accent border.
    primaryColor: v('--accent-soft'),
    primaryBorderColor: v('--accent'),
    primaryTextColor: v('--ink'),
    mainBkg: v('--accent-soft'),
    nodeBorder: v('--accent'),
    secondaryColor: v('--info-soft'),
    secondaryBorderColor: v('--info'),
    secondaryTextColor: v('--ink'),
    tertiaryColor: v('--sidebar'),
    tertiaryBorderColor: v('--hairline'),
    tertiaryTextColor: v('--ink'),
    clusterBkg: v('--sidebar'),
    clusterBorder: v('--hairline'),
    titleColor: v('--ink'),
    edgeLabelBackground: v('--paper'),
    // Sequence diagrams.
    actorBkg: v('--accent-soft'),
    actorBorder: v('--accent'),
    actorTextColor: v('--ink'),
    actorLineColor: v('--hairline'),
    signalColor: v('--muted'),
    signalTextColor: v('--ink'),
    labelBoxBkgColor: v('--sidebar'),
    labelBoxBorderColor: v('--hairline'),
    labelTextColor: v('--ink'),
    activationBkgColor: v('--accent-soft'),
    activationBorderColor: v('--accent'),
    sequenceNumberColor: v('--paper'),
    // Notes.
    noteBkgColor: v('--warn-soft'),
    noteBorderColor: v('--warn'),
    noteTextColor: v('--ink'),
  };
}

const THEME_CSS = `
  .node rect, .node .label-container, .cluster rect, .actor, rect.note, .labelBox { rx: 10px; ry: 10px; }
  .node polygon, .node circle, .node rect, .node path { stroke-width: 1.5px; }
  .edgePath .path, .flowchart-link { stroke-width: 1.5px; }
  .edgeLabel, .edgeLabel p { font-size: 12px; }
  .cluster-label, .titleText { font-weight: 600; }
  .node, .node *, .actor, .note, rect, polygon { filter: none !important; }
`;

async function mermaid() {
  loading ??= import('mermaid').then((m) => m.default);
  const m = await loading;
  const dark = isDark();
  const theme = dark ? 'dark' : 'light';
  if (themed !== theme) {
    m.initialize({
      startOnLoad: false,
      securityLevel: 'strict',
      theme: 'base',
      themeVariables: themeVariables(dark),
      themeCSS: THEME_CSS,
      flowchart: { curve: 'basis', padding: 14, nodeSpacing: 44, rankSpacing: 52 },
      sequence: { mirrorActors: false, actorMargin: 60 },
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
