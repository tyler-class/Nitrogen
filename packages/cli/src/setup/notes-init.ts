import { DEFAULT_CONFIG, formatConfig } from '@nitrogen/core';
import { CLAUDE_MD, formatMd } from '@nitrogen/mcp-guide';

const INDEX_WORKFLOW = `name: nitrogen-index
on:
  push: { branches: [main] }
  workflow_dispatch: {}
concurrency: { group: nitrogen-index, cancel-in-progress: true }
jobs:
  index:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: tyler-class/nitrogen/action@v0
        with:
          worker-url: \${{ vars.NITROGEN_URL }}
          ingest-secret: \${{ secrets.NITROGEN_INGEST_SECRET }}
`;

/** Files `nitrogen init` / setup commits into a fresh notes repo (never overwrites). */
export function initFiles(opts: { branch?: string; demo?: boolean } = {}): Record<string, string> {
  const files: Record<string, string> = {
    '.nitrogen/config.yml': formatConfig({ ...DEFAULT_CONFIG, default_branch: opts.branch ?? 'main' }),
    'FORMAT.md': formatMd(),
    'CLAUDE.md': CLAUDE_MD,
    '.github/workflows/nitrogen-index.yml': INDEX_WORKFLOW.replace('[main]', `[${opts.branch ?? 'main'}]`),
    'index.md': '---\ntitle: Home\npinned: true\n---\n\n# Home\n\nWelcome to your Nitrogen wiki. Start with the [welcome page](/welcome/index.md).\n',
  };
  if (opts.demo !== false) {
    files['welcome/index.md'] = `---\ntitle: Welcome\norder: 10\n---\n\n# Welcome\n\nThis wiki lives in a GitHub repo. Every edit is a commit.\n\n> [!tip] Try it\n> Open the [format tour](/welcome/format-tour.md) to see every block.\n`;
    files['welcome/format-tour.md'] = `---\ntitle: Format tour\norder: 20\ntags: [demo]\n---\n\n# Format tour\n\n> [!note]+ Callouts\n> Use callouts for notes, warnings and decisions.\n\n<details>\n<summary>A toggle</summary>\n\nHidden until opened.\n\n</details>\n\n:::drawer{title="A drawer"}\nOpens in a side panel.\n:::\n\n<!--nitrogen:table style=zebra caption="A table"-->\n| Block | Syntax |\n| --- | --- |\n| Callout | \`> [!note]\` |\n| Drawer | \`:::drawer\` |\n\n\`\`\`mermaid\nflowchart LR\n  Idea --> Note --> Commit\n\`\`\`\n\n- [x] Read the [home page](/index.md)\n- [ ] Write your first page\n`;
  }
  return files;
}
