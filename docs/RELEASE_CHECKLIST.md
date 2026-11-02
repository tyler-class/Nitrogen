# Release checklist

Real accounts cannot be faked. Run this by hand before every release.

1. `pnpm install && pnpm lint && pnpm typecheck && pnpm test && pnpm build` are green.
2. Fresh-account run: in a new Cloudflare account and a GitHub account without a Nitrogen app,
   run `npm create nitrogen@latest` from a clean machine. Count browser confirmations (<= 3).
3. Run `nitrogen setup` again: it reports every step as done and changes nothing.
4. `nitrogen doctor` is all green.
5. iPhone Safari: sign in, Add to Home Screen, open a page, edit offline, reconnect, see the commit.
6. claude.ai: add the connector, ask Claude to create a page with every construct; Activity shows a
   Claude commit; revert it.
7. `nitrogen export --profile gfm` of the demo vault renders correctly on GitHub (docs/MANUAL_CHECKS.md).
8. `nitrogen teardown`, delete the GitHub App by hand.
9. Bump versions, build `action/dist`, tag `vX.Y.Z`, publish `@nitrogen/core`, `@nitrogen/cli`,
   `create-nitrogen`.
