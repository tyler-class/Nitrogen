// Selfhost Kit: the words for Settings → "Connect an AI assistant", the same in every app.
// Synced from tyler-class/selfhost-kit (kit/client/assistants.ts). Edit it there, not here.
//
// Layout (every app, in its own styling), kept short:
//   1. Heading "Connect an AI assistant", one line of intro (ASSISTANT_INTRO), the MCP URL with
//      a Copy button, and the sign-in note (signInNote).
//   2. "Connected": a list of connected assistants (name + date connected), "No assistants are
//      connected." when empty, and "Disconnect all" (tap twice to confirm) under the list.
//   3. "Set up": one row of toggle chips, one per entry in ASSISTANTS. Nothing is open at first;
//      tapping a chip shows that assistant's steps under the row, tapping it again (or another
//      chip) closes it. Only one open at a time.
//   4. "Example prompts": collapsed by default; opens the app's own examples (tap to copy).

export interface AssistantSetup {
  id: 'claude' | 'chatgpt' | 'claude-code' | 'other';
  name: string;
  /** Numbered steps. */
  steps: string[];
  /** A command to copy (Claude Code). */
  command?: string;
  /** A line under the command. */
  after?: string;
}

export const ASSISTANT_INTRO = (title: string) =>
  `Let Claude, ChatGPT or any assistant that supports MCP read and update your ${title}.`;

export const signInNote = (title: string) =>
  `When you connect, a ${title} sign-in page opens. Enter your password there to approve the assistant.`;

export const CONNECTED_TEXT = {
  heading: 'Connected',
  none: 'No assistants are connected.',
  disconnectAll: 'Disconnect all',
  confirm: 'Tap again to disconnect all',
  setUp: 'Set up',
  examples: 'Example prompts',
  examplesHint: 'Tap one to copy it.',
  urlLabel: (title: string) => `Your ${title}’s connector URL`,
};

/** Steps for each assistant. `slug`: the app's short name for commands ("duffel"). */
export function assistants(title: string, slug: string, url: string): AssistantSetup[] {
  return [
    {
      id: 'claude',
      name: 'Claude',
      steps: [
        'Open Settings → Connectors and choose “Add custom connector”.',
        `Name it ${title} and paste the URL above.`,
        `Choose Connect, then enter your password on the ${title} page.`,
      ],
    },
    {
      id: 'chatgpt',
      name: 'ChatGPT',
      steps: [
        'In Settings, add a custom connector (MCP server). Your plan may need developer mode turned on.',
        'Paste the URL above and choose OAuth sign-in.',
        `Enter your password on the ${title} page.`,
      ],
    },
    {
      id: 'claude-code',
      name: 'Claude Code',
      steps: [],
      command: `claude mcp add --transport http ${slug} ${url}`,
      after: 'Then run /mcp in Claude Code and choose Authenticate.',
    },
    {
      id: 'other',
      name: 'Other apps',
      steps: [
        `Cursor, VS Code and other MCP apps: add a remote (HTTP) MCP server with the URL above. They open the ${title} sign-in page the first time.`,
      ],
    },
  ];
}
