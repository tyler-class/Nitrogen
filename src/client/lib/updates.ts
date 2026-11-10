// Settings → Updates, on top of the Selfhost Kit (src/client/kit/updates.ts).
import { useQuery } from '@tanstack/react-query';
import workflow from '../kit/update-workflow.yml?raw';
import { latestVersion, setupUrl as kitSetupUrl } from '../kit/updates';

export { isNewer, isSourceRepo, runUrl } from '../kit/updates';

/** Where Nitrogen's releases come from. */
export const UPSTREAM = 'tyler-class/Nitrogen';

/** The latest Nitrogen version on GitHub, checked every few hours. */
export function useLatestVersion() {
  return useQuery({
    queryKey: ['latest-version'],
    queryFn: () => latestVersion(UPSTREAM),
    staleTime: 6 * 3_600_000,
    retry: false,
    refetchOnWindowFocus: false,
  });
}

/** GitHub's "new file" page in this copy's repo, filled in with the update workflow. */
export const setupUrl = (repo: string, branch: string) =>
  kitSetupUrl(repo, branch, workflow, 'Nitrogen');
