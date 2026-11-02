# Manual checks

Checks that need a human or a real third-party renderer. Run before each release and record the
date and result here.

## M1: GFM export renders on GitHub

1. `pnpm n2 export --root examples/notes-repo --out /tmp/n2-export --profile gfm`
2. Push `/tmp/n2-export` to a scratch GitHub repo (or open the files in a GitHub gist).
3. Check on github.com:
   - Every internal link opens the right page (links are page-relative).
   - Images render from `assets/` with captions as hover titles.
   - Callouts render as GitHub alerts; extended types show the bold "Type: Title" lead line.
   - Drawers and toggles render as collapsed `<details>`.
   - Table captions sit above tables; alignment is kept.
   - Mermaid blocks render.
4. Repeat with `--profile commonmark` and open the files in a plain CommonMark viewer
   (e.g. `npx markdown-it`): no raw `<`, `:::` or `#align=` text appears.

| Date | Version | gfm | commonmark | Notes |
|---|---|---|---|---|
| 2026-11-02 | 0.1.0-dev | not yet run | not yet run | No GitHub write access to a scratch repo from the build environment. |
