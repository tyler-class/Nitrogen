import type { RepoService } from './service.ts';
import type { IndexStore } from '../db/store.ts';
import { commitChanges, type ChangeInput, type CommitOutcome } from './commit.ts';
import { subjectOf } from './actor.ts';
import { b64Encode } from '../util/crypto.ts';
import type { CommitMeta } from './actor.ts';

/**
 * Revert a commit: every file it touched goes back to its parent version, provided the file has
 * not changed since (each change carries baseSha = the reverted commit's blob). Otherwise 409.
 */
export async function revertCommit(repo: RepoService, store: IndexStore, sha: string, meta: CommitMeta): Promise<CommitOutcome> {
  const commit = await repo.gh.getCommitWithFiles(sha);
  const parent = commit.parents[0]?.sha;
  if (!parent) return { ok: false, status: 422, error: 'Cannot revert the initial commit.' };
  const before = await repo.tree(await repo.treeShaOf(parent));
  const changes: ChangeInput[] = [];
  for (const f of commit.files) {
    const paths = f.status === 'renamed' && f.previous_filename ? [f.previous_filename, f.filename] : [f.filename];
    for (const path of paths) {
      const after = f.status === 'removed' || (f.status === 'renamed' && path === f.previous_filename) ? null : f.sha;
      const prev = before.get(path);
      if (!prev) changes.push({ path, op: 'delete', baseSha: after });
      else {
        const bytes = await repo.blob(prev.sha);
        changes.push(path.endsWith('.md') ? { path, op: 'put', content: new TextDecoder().decode(bytes), baseSha: after } : { path, op: 'put', contentB64: b64Encode(bytes), baseSha: after });
      }
    }
  }
  return commitChanges(repo, store, { changes, meta, message: `Revert "${subjectOf(commit.commit.message)}"`, rewriteInbound: false });
}
