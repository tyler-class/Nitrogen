// Selfhost Kit: which GitHub repo and branch this copy is built from, for vite.config.ts.
// Synced from tyler-class/selfhost-kit (kit/scripts/source.ts).
//
// Workers Builds checks out the installer's own repo, so its origin is their copy. Set
// SOURCE_REPO=owner/repo to name it yourself (or to try Settings → Updates locally).
import { execSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';

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

/** This build is the app's own source repo (its upstream in selfhost.json), not a copy. */
export function isSourceBuild(repo = sourceRepo()): boolean {
  try {
    const { upstream } = JSON.parse(readFileSync('selfhost.json', 'utf8')) as { upstream: string };
    return !!repo && repo.toLowerCase() === upstream.toLowerCase();
  } catch {
    return false;
  }
}

/**
 * Automatic updates are really on: this copy's repo has the update workflow. Cloudflare
 * builds from the repo, and adding the workflow is itself a commit, so the next build sees it.
 * Never true for the source repo (it has the file but nothing to update from).
 */
export const updatesOn = (repo = sourceRepo()) =>
  !isSourceBuild(repo) && existsSync('.github/workflows/update.yml');

/**
 * Vite `define` entries for the client and the Worker: __SOURCE_REPO__, __SOURCE_BRANCH__,
 * __UPDATES_ON__ and __IS_SOURCE__ (declared in src/shared/kit/build.d.ts).
 */
export const sourceDefines = () => {
  const repo = sourceRepo();
  return {
    __SOURCE_REPO__: JSON.stringify(repo),
    __SOURCE_BRANCH__: JSON.stringify(sourceBranch()),
    __UPDATES_ON__: JSON.stringify(updatesOn(repo)),
    __IS_SOURCE__: JSON.stringify(isSourceBuild(repo)),
  };
};
