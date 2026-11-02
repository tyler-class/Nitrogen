import { CALLOUT_TYPES } from '@nitrogen/core';

export interface Snippet {
  id: string;
  label: string;
  /** Text to insert; `$|` marks the cursor. */
  text: string;
  block?: boolean;
}

export const MERMAID_TEMPLATES: Record<string, string> = {
  Flowchart: 'flowchart LR\n  A[Start] --> B{Decision}\n  B -->|Yes| C[Do it]\n  B -->|No| D[Skip]',
  Sequence: 'sequenceDiagram\n  participant A as Client\n  participant B as Server\n  A->>B: Request\n  B-->>A: Response',
  State: 'stateDiagram-v2\n  [*] --> Draft\n  Draft --> Active\n  Active --> Archived',
  'Entity relationship': 'erDiagram\n  ACCOUNT ||--o{ OPPORTUNITY : has\n  OPPORTUNITY ||--|{ LINE_ITEM : contains',
  Timeline: 'timeline\n  title Roadmap\n  2026 Q4 : v0.1\n  2027 Q1 : v0.2',
};

export const SNIPPETS: Snippet[] = [
  { id: 'h2', label: 'Heading', text: '## $|', block: true },
  { id: 'h3', label: 'Subheading', text: '### $|', block: true },
  { id: 'list', label: 'Bulleted list', text: '- $|', block: true },
  { id: 'task', label: 'Task', text: '- [ ] $|', block: true },
  { id: 'quote', label: 'Quote', text: '> $|', block: true },
  { id: 'code', label: 'Code block', text: '```ts\n$|\n```', block: true },
  ...CALLOUT_TYPES.map((t) => ({ id: `callout-${t}`, label: `Callout: ${t}`, text: `> [!${t}] $|\n> `, block: true })),
  { id: 'toggle', label: 'Toggle', text: '<details>\n<summary>$|Title</summary>\n\nBody\n\n</details>', block: true },
  { id: 'drawer', label: 'Drawer', text: ':::drawer{title="$|Title"}\nBody\n:::', block: true },
  { id: 'table', label: 'Table', text: '<!--nitrogen:table style=zebra-->\n| $|Column | Column |\n| --- | --- |\n| Cell | Cell |', block: true },
  ...Object.entries(MERMAID_TEMPLATES).map(([k, v]) => ({ id: `mermaid-${k}`, label: `Mermaid: ${k}`, text: `\`\`\`mermaid\n${v}$|\n\`\`\``, block: true })),
  { id: 'link', label: 'Link', text: '[$|text](/path.md)' },
  { id: 'wikilink', label: 'Wikilink', text: '[[$|' },
];
