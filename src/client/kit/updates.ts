// Selfhost Kit: is a newer release out, and links into this copy's own GitHub repo to add or
// run its update workflow. Synced from tyler-class/selfhost-kit (kit/client/updates.ts).
//
// Updates go: the app's source repo → the installer's GitHub copy (update workflow) → their
// Cloudflare (Workers Builds deploys every push). Nothing here deploys anything.

/** "1.2.10" is newer than "1.2.9". */
export function isNewer(a: string, b: string): boolean {
  const pa = a.split(/[.+-]/).map(Number);
  const pb = b.split(/[.+-]/).map(Number);
  for (let i = 0; i < 3; i++) {
    const d = (pa[i] || 0) - (pb[i] || 0);
    if (d) return d > 0;
  }
  return false;
}

/** The version in the source repo's package.json on main. */
export async function latestVersion(upstream: string): Promise<string> {
  const r = await fetch(`https://raw.githubusercontent.com/${upstream}/main/package.json`, {
    cache: 'no-store',
  });
  if (!r.ok) throw new Error(`GitHub said ${r.status}`);
  return ((await r.json()) as { version: string }).version;
}

/** GitHub's "new file" page in the copy's repo, filled in with the update workflow. */
export function setupUrl(repo: string, branch: string, workflow: string, app: string): string {
  const q = new URLSearchParams({
    filename: '.github/workflows/update.yml',
    value: workflow,
    message: `Turn on automatic ${app} updates`,
  });
  return `https://github.com/${repo}/new/${encodeURIComponent(branch)}?${q}`;
}

/** The update workflow's page in the copy's repo, with its "Run workflow" button. */
export const runUrl = (repo: string) => `https://github.com/${repo}/actions/workflows/update.yml`;

/** Whether this build is the app's own source repo (which has nothing to update from). */
export const isSourceRepo = (repo: string, upstream: string) =>
  repo.toLowerCase() === upstream.toLowerCase();

/** The words in Settings → Updates, the same in every app. */
export const UPDATE_TEXT = {
  heading: 'Updates',
  setUp: 'Set up automatic updates',
  setUpHint: 'Opens GitHub: click Commit changes. It updates now, then every Monday.',
  updateNow: 'Update now',
  updateNowHint: 'Opens GitHub: click Run workflow.',
  setUpAgain: 'Set up again',
  byHand: 'Deployed by hand: git pull, then npm run deploy.',
  telemetry: 'Share anonymous usage counts',
  howUpdatesWork: 'How updates work',
  whatsShared: 'What’s shared',
};

/** "Duffel 0.13.0 is available. You have 0.12.3." and friends. */
export function updateStatus(
  title: string,
  current: string,
  latest: string | null | undefined,
  failed: boolean,
): { text: string; newer: boolean } {
  if (latest && isNewer(latest, current))
    return { text: `${title} ${latest} is available. You have ${current}.`, newer: true };
  if (failed)
    return { text: `${title} ${current}. Couldn’t check for a newer version.`, newer: false };
  if (latest) return { text: `${title} ${current}, up to date.`, newer: false };
  return { text: `${title} ${current}.`, newer: false };
}

/** The ⓘ beside Updates: how the two steps work. */
export const howUpdatesWork = (title: string) => ({
  intro: 'Updates take two steps, both in your own accounts:',
  steps: [
    `An update workflow in your GitHub copy brings in the latest ${title} every Monday. GitHub needs you to add it once: Set up opens it ready to commit.`,
    'Cloudflare deploys your copy every time it changes. That part is already on.',
  ],
  outro:
    'Your data lives in your database, so updates don’t touch it. Changes you made to the code in your copy are replaced.',
});

/** The ⓘ beside the usage-counts switch: exactly what's sent. `counted`: "trips, items and bags". */
export const whatsShared = (title: string, counted: string, files: boolean) => ({
  intro: `Once a day this copy sends ${title}’s developer:`,
  items: [
    'a random id this copy made for itself',
    'its version',
    `how many ${counted} it has (counts only)`,
    ...(files ? ['how many files it stores (one number)'] : []),
    'whether automatic updates are on',
  ],
  outro:
    'Never names, contents or anything you type, and no IP address is kept. It shows how many copies are in use, to decide what to work on next.',
});
