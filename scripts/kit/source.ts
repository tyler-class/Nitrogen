// Selfhost Kit: which GitHub repo and branch this copy is built from, for vite.config.ts.
// Synced from tyler-class/selfhost-kit (kit/scripts/source.ts).
//
// Workers Builds checks out the installer's own repo, so its origin is their copy. Set
// SOURCE_REPO=owner/repo to name it yourself (or to try Settings → Updates locally).
import { execSync } from 'node:child_process';

const git = (args: string) => execSync(`git ${args}`, { encoding: 'utf8' }).trim();

/** "owner/repo", or "" when it can't tell. */
export function sourceRepo(): string {
  if (process.env.SOURCE_REPO) return process.env.SOURCE_REPO;
  try {
    return (
      /github\.com[/:]([\w.-]+\/[\w.-]+?)(?:\.git)?$/.exec(
        git('config --get remote.origin.url'),
      )?.[1] ?? ''
    );
  } catch {
    return '';
  }
}

/** The branch Cloudflare deploys from. */
export function sourceBranch(): string {
  if (process.env.WORKERS_CI_BRANCH) return process.env.WORKERS_CI_BRANCH;
  try {
    const b = git('rev-parse --abbrev-ref HEAD');
    return b && b !== 'HEAD' ? b : 'main';
  } catch {
    return 'main';
  }
}

/** Vite `define` entries for the client: __SOURCE_REPO__ and __SOURCE_BRANCH__. */
export const sourceDefines = () => ({
  __SOURCE_REPO__: JSON.stringify(sourceRepo()),
  __SOURCE_BRANCH__: JSON.stringify(sourceBranch()),
});
