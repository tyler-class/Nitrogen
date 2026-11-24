// Settings → Updates, on top of the Selfhost Kit (src/client/kit/updates.ts).
import { useQuery } from '@tanstack/react-query';
import workflow from '../kit/update-workflow.yml?raw';
import { latestVersion, setupUrl as kitSetupUrl } from '../kit/updates';

export { isNewer, isSourceRepo, runUrl } from '../kit/updates';

/** Where Nitrogen's releases come from. */
export const UPSTREAM = 'tyler-class/Nitrogen';

/**
 * The latest Nitrogen version on GitHub. Asked again each time Settings opens (and when the app comes
 * back to the front) once the last answer is 5 minutes old, so a release merged while the app
 * stayed open shows up, and Update now isn't hidden by an old "up to date".
 */
export function useLatestVersion() {
  return useQuery({
    queryKey: ['latest-version'],
    queryFn: () => latestVersion(UPSTREAM),
    staleTime: 5 * 60_000,
    retry: false,
    refetchOnMount: true,
    refetchOnWindowFocus: true,
  });
}

/** GitHub's "new file" page in this copy's repo, filled in with the update workflow. */
export const setupUrl = (repo: string, branch: string) =>
  kitSetupUrl(repo, branch, workflow, 'Nitrogen');
