// Selfhost Kit: facts about this build, worked out by scripts/kit/source.ts in vite.config.ts.
// Synced from tyler-class/selfhost-kit (kit/shared/build.ts). Edit it there, not here.

declare const __UPDATES_ON__: boolean | undefined;
declare const __IS_SOURCE__: boolean | undefined;

/**
 * updatesOn: this copy's GitHub repo has the update workflow (checked at build time).
 * source: this is the app's own source repo, which has nothing to update from.
 * real: built by Vite (false in test runs, which must never check in).
 * All false where the build didn't set them (tests, old configs).
 */
export function buildFlags(): { updatesOn: boolean; source: boolean; real: boolean } {
  return {
    updatesOn: typeof __UPDATES_ON__ === 'boolean' && __UPDATES_ON__,
    source: typeof __IS_SOURCE__ === 'boolean' && __IS_SOURCE__,
    // A real Vite build (dev or deploy) sets these; test runs don't.
    real: typeof __IS_SOURCE__ === 'boolean',
  };
}
