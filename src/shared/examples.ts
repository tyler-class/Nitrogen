// Example requests people can make of an assistant connected to Nitrogen. One list feeds the MCP
// server instructions, the get_started tool and the "Try asking" list in Settings.

export interface ExamplePrompt {
  /** What to say, written the way a person would ask. <angle brackets> mark what to fill in. */
  prompt: string;
  /** Why it's worth asking, in a few words. */
  why: string;
}

export const EXAMPLE_PROMPTS: ExamplePrompt[] = [
  {
    prompt:
      'Save the decisions and open questions from this conversation to my wiki, on the right project pages.',
    why: 'Keeps what you worked out instead of losing it in chat history.',
  },
  {
    prompt: 'What changed in my wiki this week, and what did other assistants add?',
    why: 'Catch up across sessions and agents in one answer.',
  },
  {
    prompt:
      'Using only my wiki, write a one-page brief on <topic> with links to the source pages, and list what’s missing.',
    why: 'Answers grounded in your own notes, with the gaps called out.',
  },
  {
    prompt:
      'Set up a project for <name>: overview, goals, decisions log and meeting notes pages, tagged and linked.',
    why: 'A ready structure in one step.',
  },
  {
    prompt:
      'Tidy up <section>: find duplicates and pages that should be linked or merged, and propose a cleaner structure before changing anything.',
    why: 'Keeps a growing wiki navigable.',
  },
  {
    prompt: 'Check <page> against newer pages and tell me what’s out of date.',
    why: 'Catches stale decisions and numbers.',
  },
  {
    prompt:
      'What’s due or overdue across my wiki, and which questions are still open on <project>?',
    why: 'A start-of-day list from every page.',
  },

  {
    prompt:
      'Turn this meeting transcript into a page under <project>: summary, decisions, and todo and question items with owners and dates.',
    why: 'Action items roll up on their own.',
  },
];

/** The ready-made MCP prompts, for listing alongside the examples. */
export const MCP_PROMPTS: { name: string; title: string; does: string }[] = [
  {
    name: 'capture_conversation',
    title: 'Save this conversation to the wiki',
    does: 'Files decisions, notes and open questions into the right pages, then logs the session.',
  },
  {
    name: 'catch_up',
    title: 'Catch up on recent changes',
    does: 'Summarizes what changed, who changed it, and what needs your attention.',
  },
  {
    name: 'research_brief',
    title: 'Brief from the wiki',
    does: 'Answers a question using only your pages, with links and a list of gaps.',
  },
  {
    name: 'tidy_section',
    title: 'Tidy up a section',
    does: 'Finds duplicates, missing links and tags, and proposes a cleaner structure.',
  },
  {
    name: 'review_page',
    title: 'Check a page for stale claims',
    does: 'Compares a page with newer pages and lists what’s out of date.',
  },
];
