# How deploys and updates work

This is the shared setup behind HSA Locker, Duffel, Ratio and Nitrogen: self-hosted Cloudflare apps that anyone installs with one click and that then keep themselves up to date. It's written for the maintainer. The README tells users what they need to know.

## The moving parts

```
 tyler-class/<App> (source repo)                you push releases here
        │
        │  Deploy to Cloudflare button (once, per user)
        ▼
 <user>/<app> (their own copy on GitHub) ──push to main──▶ Workers Builds ──▶ their Worker
        ▲                                                (npm run build,       (+ their D1, R2,
        │                                                 then deploy script)   KV, secrets)
        │  update.yml, every Monday (or Run workflow):
        │  replace the code with the source repo's main, commit, push
 tyler-class/<App>
```

### 1. The Deploy to Cloudflare button

The README's button links to `https://deploy.workers.cloudflare.com/?url=https://github.com/tyler-class/<App>`. When someone clicks it, Cloudflare:

1. **Copies the repo** into their GitHub (or GitLab) account. It's a plain copy, not a fork, so GitHub's "Sync fork" doesn't exist for it.
2. **Creates the resources** in their Cloudflare account from `wrangler.jsonc`: D1, R2, KV, the Workers AI binding and cron triggers. `wrangler.jsonc` has **no ids** (no `database_id`, no `bucket_name`) so nothing points at your resources.
3. **Asks for secrets.** It lists the names in `.dev.vars.example` (for example `APP_PASSWORD`), with the help text from `package.json` → `cloudflare.bindings`.
4. **Connects Workers Builds** to their copy's `main` branch, and runs the first build and deploy.

After that, every push to `main` in their copy builds and deploys their Worker. Nobody configures this by hand.

### 2. The deploy script: migrate, then deploy

Workers Builds runs `npm run build`, then the deploy script. In HSA Locker and Duffel that's `npm run deploy` → `npm run build && npm run release`. `scripts/release.ts`:

1. Applies D1 migrations to the remote database first, so new code never runs against missing columns.
2. Deploys the Worker.
3. On a **first install** the database doesn't exist until `wrangler deploy` creates it, so the first migration fails with "couldn't find…". The script notices, deploys first, then migrates.

Migration rule that follows from this: **migrations must be safe for the version that is still running.** The old code keeps serving for the seconds between migrating and deploying. Add tables and columns freely; don't drop or rename something the previous version reads. Do that in a later release instead.

#### Why the database goes first

An update changes two things: the **code** the Worker runs and the **database layout** (which tables and columns exist). A migration is the SQL file that changes the layout.

- **Deploy first, then migrate:** the new code goes live and asks for a column that doesn't exist yet. For a few seconds people see errors. If the migration then fails, the new code stays live against the old database and the app stays broken.
- **Migrate first, then deploy (what we do):** the database gains the new column while the old code is still running. The old code ignores what it doesn't know, so nothing breaks. Then the new code goes live and finds everything it needs. If the migration fails, the deploy never happens and the old version keeps working.

This is the standard approach, often called **expand, then contract**:

1. **Expand:** a release adds what the new code needs (tables, columns, indexes). Ship it with the code that uses them.
2. **Contract:** removing or renaming something happens in a **later** release, once no running version uses it. To rename a column: add the new one and write to both, then switch reads, then drop the old one in a following release.

New columns must work for rows that already exist: give them a default or allow NULL.

#### Switching a project to database-first

For a project whose `deploy` script is `wrangler deploy && wrangler d1 migrations apply DB --remote`:

1. Copy `scripts/release.ts` from HSA Locker unchanged. It migrates, deploys, and handles the first install (where the database only exists after the first deploy).
2. In `package.json` set:
   - `"deploy": "npm run build && npm run release"`
   - `"release": "tsx scripts/release.ts"`
3. Make sure `tsx` is in `devDependencies` and `scripts` is in `tsconfig.node.json`'s `include`.
4. If the Worker is connected to Workers Builds, change its **Deploy command** to `npm run release` (Settings → Builds).
5. Ship it as a normal release. The next deploy migrates first.

### 3. The weekly update workflow

`.github/workflows/update.yml` ships inside every copy. It:

- runs **every Monday** on a schedule, and any time from **Actions → Update <App> → Run workflow**;
- **skips itself in the source repo** (`if: github.repository != 'tyler-class/<App>'`);
- fetches the source repo's `main`, replaces the copy's files with it, and commits **only if something changed**. That push triggers Workers Builds, which migrates and deploys;
- **keeps** two things from the copy: its `.github/workflows` (see the limits below) and a `wrangler.jsonc` that has a `database_id` written in (from a hand install);
- finishes with a **keep-alive step**. GitHub turns off scheduled workflows in a repo with no activity for 60 days, and quiet months produce no commits. The step re-enables the workflow on every run (`gh api -X PUT …/actions/workflows/update.yml/enable`), which resets the timer. It needs `permissions: actions: write`.

User data lives in D1, R2 and KV, never in the repo, so updates don't touch it.

### 4. Your own instance

If you deployed with `npm run deploy` from your machine (not the button), your Worker isn't connected to the repo until you connect it once: **Workers & Pages → <app> → Settings → Builds → Connect**.

- Repository: `tyler-class/<App>`, branch `main`.
- Build command: `npm run build`.
- **Deploy command: `npm run release`** (not the default `npx wrangler deploy`, which skips migrations). For Ratio, see the table below.
- **Turn off preview builds.** Preview versions share the production D1, R2 and KV, so a branch build would touch real data.

From then on, a push to `main` is a deploy. Treat it that way.

## Shipping a release

1. Make the change. `npm run typecheck`, `npm run lint`, `npm test`.
2. Bump `version` in `package.json` (and `src/shared/version.ts` in Nitrogen), one commit per version.
3. `git tag -a <version> -m "<App> <version>"` and `git push origin main --follow-tags`.
4. Your instance deploys within a couple of minutes (Workers Builds).
5. Everyone else's copy picks it up the next Monday, or sooner if they run the workflow.
6. Optional: publish a GitHub Release for the tag with short notes. People who use **Watch → Custom → Releases** on the repo get an email from GitHub; you never hold a list of addresses.

## What can't update automatically

- **Workflow files.** GitHub doesn't let an Action's token change files in `.github/workflows`. A change to `update.yml` itself (like adding the keep-alive step) only reaches copies made after it. Existing copies need it pasted in once by hand. The workflow prints a notice when the copy's workflows differ from the source.
- **Hand installs** (clone + `npm run deploy`). They have no copy on GitHub and no workflow. They update with `git pull && npm run deploy`.
- **New secrets.** If a release needs a new required secret, existing installs don't get prompted. Make new secrets optional, with a sensible default, and say so in the release notes.
- **Code someone changed in their copy.** The update replaces it. The README says so.

## The four projects

| Project    | Deploy script                        | update.yml | Keep-alive | Notes                                                                            |
| ---------- | ------------------------------------ | ---------- | ---------- | -------------------------------------------------------------------------------- |
| HSA Locker | build → `release.ts` (migrate first) | yes        | yes        | Reference implementation.                                                        |
| Duffel     | build → `release.ts` (migrate first) | yes        | **no**     | Add the keep-alive step and `actions: write`. Existing copies need it pasted in. |
| Ratio      | build → deploy → migrate             | **no**     | **no**     | Add `scripts/release.ts`, `release` script and `update.yml`.                     |
| Nitrogen   | build → `release.ts` (migrate first) | yes        | yes        | Remember `src/shared/version.ts`.                                                |

To bring a project in line: copy `scripts/release.ts`, set `"deploy": "npm run build && npm run release"` and `"release": "tsx scripts/release.ts"`, copy `.github/workflows/update.yml` with the repo name and app name replaced, and make sure `wrangler.jsonc` has no resource ids.

## Verify once with a real install

Some of this can only be confirmed end to end. With a second GitHub account and a free Cloudflare account:

1. Click **Deploy to Cloudflare** on the README. Check that the Worker deploys, the resources exist, and Workers Builds is connected (Settings → Builds). Note which deploy command it set.
2. Push a small release to the source repo.
3. In the copy, run **Actions → Update <App> → Run workflow**. Check that it commits, that Workers Builds deploys, and that the keep-alive step succeeds.
4. Check the app shows the new version (Settings → About).

## Appendix: files to copy

Both files are the same in every project except for the placeholders in the workflow.

### scripts/release.ts

Copy as is.

```ts
// Migrates the remote database, then deploys the Worker, so new code never runs against
// missing columns. On a first install the database doesn't exist until `wrangler deploy`
// provisions it, so migrations run once more after the deploy.
// Usage: npm run release (after npm run build). Workers Builds runs it as the deploy command.
import { spawn } from 'node:child_process';

/** Runs wrangler, streaming its output while keeping a copy to inspect. */
function wrangler(args: string[]): Promise<{ ok: boolean; output: string }> {
  return new Promise((resolve) => {
    let output = '';
    const p = spawn('npx', ['wrangler', ...args], { stdio: ['inherit', 'pipe', 'pipe'] });
    p.stdout.on('data', (d: Buffer) => ((output += d), process.stdout.write(d)));
    p.stderr.on('data', (d: Buffer) => ((output += d), process.stderr.write(d)));
    p.on('close', (code) => resolve({ ok: code === 0, output }));
  });
}

const migrate = ['d1', 'migrations', 'apply', 'DB', '--remote'];

const before = await wrangler(migrate);
const firstInstall =
  !before.ok && /couldn'?t find|not found|no database|database_id/i.test(before.output);
if (!before.ok && !firstInstall) process.exit(1);
if (firstInstall) console.log('No database yet: deploying first, then migrating.');

if (!(await wrangler(['deploy'])).ok) process.exit(1);

if (firstInstall && !(await wrangler(migrate)).ok) process.exit(1);
```

### .github/workflows/update.yml

Replace **every** placeholder before committing:

- `<REPO>`: the GitHub repo name exactly as GitHub spells it (`HSA-Locker`, `Duffel`, `ratio`, `Nitrogen`). It appears three times: the source repo check, the fetch URL and the notice.
- `<App name>`: the app's display name (`HSA Locker`, `Duffel`, `Ratio`, `Nitrogen`).

```yaml
# Keeps a copy made with the Deploy to Cloudflare button up to date with tyler-class/<REPO>.
# The button makes a plain copy, not a fork, so GitHub's "Sync fork" isn't available.
# Each run replaces the app with the latest <App name> and pushes; Cloudflare then migrates and
# redeploys. Your data lives in the database and file storage, not here, so it isn't touched.
name: Update <App name>

on:
  schedule:
    - cron: '23 9 * * 1' # Mondays
  workflow_dispatch:

permissions:
  contents: write
  # For the keep-alive step below.
  actions: write

jobs:
  update:
    # Only in copies, never in <App name> itself.
    if: github.repository != 'tyler-class/<REPO>'
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v5
      - name: Take the latest <App name>
        run: |
          git fetch --depth=1 https://github.com/tyler-class/<REPO>.git main
          upstream=$(git rev-parse FETCH_HEAD)

          # Kept from this copy: its workflows (GitHub doesn't let this job change them) and a
          # wrangler.jsonc that has its own database id written in.
          keep=$(mktemp -d)
          cp -r .github/workflows "$keep/workflows"
          if grep -q '"database_id"' wrangler.jsonc; then cp wrangler.jsonc "$keep/"; fi

          git rm -rq .
          git checkout "$upstream" -- .
          rm -rf .github/workflows && cp -r "$keep/workflows" .github/workflows
          if [ -f "$keep/wrangler.jsonc" ]; then cp "$keep/wrangler.jsonc" .; fi
          git add -A

          if git diff --cached --quiet; then
            echo "Already up to date."
            exit 0
          fi
          if ! git diff --quiet "$upstream" HEAD -- .github/workflows 2>/dev/null; then
            echo "::notice::Your .github/workflows differ from <App name>'s and were left as they are. Copy any you want from tyler-class/<REPO> by hand."
          fi
          git -c user.name='github-actions[bot]' \
              -c user.email='41898282+github-actions[bot]@users.noreply.github.com' \
              commit -qm "Update <App name> to ${upstream:0:7}"
          git push

      # GitHub turns off scheduled workflows in a repo with no activity for 60 days, and this one
      # only commits when there's a new version. Re-enabling it on every run resets that timer,
      # so the weekly check never switches itself off.
      - name: Keep this workflow enabled
        if: always()
        env:
          GH_TOKEN: ${{ github.token }}
        run: gh api -X PUT "repos/${{ github.repository }}/actions/workflows/update.yml/enable"
```

## Prompt for another project's agent

Paste this doc, then this prompt, filling in the first line:

> This repo is **<App name>** (`tyler-class/<REPO>`). Bring it in line with the doc above:
>
> 1. If `package.json`'s `deploy` script runs `wrangler deploy` before migrating, switch to database-first: add `scripts/release.ts` from the appendix and set the `deploy` and `release` scripts as described. Check `tsx` is a dev dependency and `scripts` is in `tsconfig.node.json`.
> 2. Add or update `.github/workflows/update.yml` from the appendix with every placeholder replaced. If the repo already has one, keep anything project-specific and add the keep-alive step and `actions: write`.
> 3. Check `wrangler.jsonc` has no resource ids (`database_id`, KV `id`, `bucket_name`) and that the README's Deploy button and “Update your copy” section match.
> 4. Bump the version per this repo's convention, run typecheck, lint and tests, and commit. Don't push: pushing to main may deploy. Tell me what you changed and anything that didn't fit.
