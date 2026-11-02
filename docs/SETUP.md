# Setup

One command and three browser clicks. Everything else is scripted, idempotent and resumable.

## Before you start

- A GitHub account and a Cloudflare account (free plans are enough).
- Node 22+, git, and the GitHub CLI (`gh`). Setup offers `gh auth login` if you are not signed in.

## Run it

```sh
npm create nitrogen@latest
# or, from a clone of this repo:
pnpm install && pnpm --filter @nitrogen/web build && pnpm n2 setup
```

Flags (all optional; every prompt has one): `--repo notes`, `--worker-name nitrogen-notes`,
`--allow-github-id 123`, `--branch main`, `--no-demo`, `--yes`.

## What happens

| Step | Automated | You |
|---|---|---|
| Preflight | Node, git, gh, wrangler; reads your GitHub id for the allowlist | |
| Cloudflare login | `wrangler whoami`, `wrangler login` if needed | **Click 1:** approve Cloudflare login (skipped when already signed in) |
| Notes repo | `gh repo create <name> --private` if missing | |
| D1 + KV | `wrangler d1 create`, `wrangler kv namespace create`, migrations, `wrangler.generated.jsonc` | |
| First deploy | `wrangler deploy` to learn the workers.dev URL | If you never opened Workers in the dashboard, register a workers.dev subdomain first |
| GitHub App | Manifest flow on a localhost page; credentials go straight to Worker secrets over stdin | **Click 2:** "Create GitHub App" |
| Install | Opens the install page, polls until the installation appears | **Click 3:** install on the notes repo only |
| Secrets | session, cookie and ingest secrets generated in memory; `wrangler secret put` over stdin; redeploy | |
| Init repo | commits `.nitrogen/config.yml`, `FORMAT.md`, `CLAUDE.md`, demo pages, the index workflow (never overwrites) | |
| Actions | `gh secret set NITROGEN_INGEST_SECRET`, `gh variable set NITROGEN_URL`, dispatches the index workflow | |
| Verify | `nitrogen doctor` | |

Progress (no secrets) lives in `~/.config/nitrogen/setup.json`. Re-run `nitrogen setup` any time;
finished steps are skipped and a second run changes nothing.

## After setup (manual by nature)

1. **Claude:** claude.ai > Settings > Connectors > Add custom connector > paste `https://<worker>/mcp`.
   Sign in with GitHub when asked. Claude Code: `claude mcp add --transport http nitrogen https://<worker>/mcp`.
2. **iPhone:** open the wiki URL in Safari > Share > Add to Home Screen.

## Other commands

- `nitrogen doctor [--url]`: read-only health check with fix hints.
- `nitrogen rotate-keys`: new session, cookie and ingest secrets (signs everyone out).
- `nitrogen upgrade`: migrations, rebuild, redeploy.
- `nitrogen teardown [--delete-repo]`: deletes the Worker, D1 and KV. GitHub Apps cannot be deleted
  through the API; teardown prints the settings link.

## Troubleshooting

- *Could not find the workers.dev URL*: open Cloudflare dashboard > Workers & Pages once to create
  your workers.dev subdomain, then re-run setup.
- *Installation never appears*: make sure you installed the app on the account that owns the notes
  repo. If setup was interrupted after creating the app, it asks you to paste the installation id.
