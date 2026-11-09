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
