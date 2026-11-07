# Nitrogen (N2)

A personal wiki you host yourself on Cloudflare. Pages live in a tree, bodies are markdown, images go
straight into the page, search understands meaning, and Claude can read and write it over MCP.

[![Deploy to Cloudflare](https://deploy.workers.cloudflare.com/button)](https://deploy.workers.cloudflare.com/?url=https://github.com/tyler-class/Nitrogen)

- **A page tree.** Every page can hold subpages. Drag pages in the sidebar to reorder or nest them.
- **Markdown with wiki links.** `[[Page title]]` links pages and powers “Linked from” backlinks.
  Callouts (`> [!TIP]`), tables, task lists and code blocks render cleanly.
- **Images where you put them.** Paste, drop or pick an image in the editor; it uploads to R2 and its
  markdown lands at the cursor.
- **Semantic search.** Find pages by meaning and by keywords (Cloudflare AI Search + D1 full-text).
- **History.** Every page keeps earlier versions, each marked with who wrote it; restore any of them.
- **Claude and other assistants.** A built-in MCP server lets assistants search, read, create, edit
  and reorganize pages. Every edit is labelled with the assistant that made it, and you can undo
  a whole assistant session from the Activity page.
- **A dashboard.** An inbox of what assistants changed since you last looked, pinned pages, recent
  activity and a few numbers. Drag panels to arrange them, make them half or full width, or hide
  them; or pick a page as home instead.
- **To-dos, questions and reminders anywhere.** Write `- [ ] todo: … @owner due:2026-11-20`,
  `- question: …` or `- [ ] reminder: … due:…` on any page. They show as cards you can check off, a
  summary at the top of the page, and an Open items panel on the dashboard; assistants list them with
  `open_items`.
- **Sessions.** Every assistant session that changes the wiki is recorded automatically under a
  protected, read-only Sessions section, with the pages it touched and the assistant's own summary.
- **Exports.** A full backup that restores everything, and a Markdown export (per page or the whole
  wiki as a .zip) that downgrades callouts and items to plain text for other apps and Google Docs.
- **Tags and connections.** Tag pages (or write `#tag` in the text), see pages that mention this
  one without linking it and link them in one click, related pages found by meaning, and a local
  graph of everything within two links.
- **Insights.** Arrangeable panels like the dashboard: a calendar of edits by you and by assistants, who writes the wiki, what's busiest, what
  needs attention, and what assistants searched for and couldn't find.
- **Yours.** It runs on your Cloudflare account; the free plan is enough for a personal wiki.

## Deploy

### One click

1. Click **Deploy to Cloudflare** above and sign in (a free account works).
2. Cloudflare copies this repo to your GitHub or GitLab account, creates the database (D1), image
   storage (R2) and sign-in store (KV), and asks for **APP_PASSWORD**, the password you’ll sign in
   with. Pick something long.
3. Open the `*.workers.dev` link when the deploy finishes and sign in.

The deploy command (`npm run deploy`) builds the app, applies database migrations, then deploys the
Worker, so new code never runs against an older database. Semantic search needs no setup: Nitrogen
creates its AI Search index the first time it saves a page.

### By hand

```sh
git clone https://github.com/tyler-class/Nitrogen.git && cd Nitrogen
npm install
npx wrangler login
npm run deploy
npx wrangler secret put APP_PASSWORD
```

Wrangler creates the D1 database, R2 bucket and KV namespace on the first deploy.

## Update your copy

If you deployed with the button, your copy lives in your own GitHub account and updates itself:
every Monday a GitHub Action takes the latest Nitrogen and pushes it to your copy, and Cloudflare
migrates the database and redeploys. To update right away, open your copy on GitHub, go to
**Actions → Update Nitrogen** and click **Run workflow**. Your pages and images are in the database
and R2, not the repo, so updates don’t touch them.

The update replaces the app’s code, so changes you made to your copy’s code are overwritten. Your
`.github/workflows` and a `wrangler.jsonc` with your database id are kept.

If you deployed by hand, `git pull` and `npm run deploy`.

How the button, Workers Builds and the update workflow fit together:
[docs/deploy-and-updates.md](docs/deploy-and-updates.md).

## Connect Claude

In Nitrogen, open **Settings → Connect an AI assistant** and copy your MCP URL
(`https://<your-nitrogen>/mcp`).

- **Claude (web, desktop, mobile):** Settings → Connectors → Add custom connector → paste the URL.
  Approve with your wiki password.
- **Claude Code:** `claude mcp add --transport http nitrogen https://<your-nitrogen>/mcp`

Tools: `get_tree`, `read_page`, `search`, `create_page`, `create_pages` (a whole subtree at once),
`edit_page` (find/replace, section edits, append), `update_page`, `move_page`, `delete_page`
(confirmed by title), `list_revisions`, `read_revision`, `restore_revision`, `list_tags`,
`tag_page`, `log_session` (adds a title and summary to the assistant’s automatic Sessions entry),
`open_items` (to-dos, questions and reminders across the wiki), `recent_changes` (what changed, grouped by who), `get_started` (the wiki’s state plus
example requests; assistants call it when you ask what they can do), and for images:

- `add_image`: from a public URL or base64 bytes.
- `request_image_upload`: for an image you have, such as one attached in chat (chat attachments
  can't be passed to tools). Claude gives you a one-time link; open it on any device and drop the
  image. Valid for an hour.
- `image_upload_status`: checks whether an upload link has been used yet.

Ready-made prompts appear in Claude’s **+** menu: **Save this conversation to the wiki**
(`capture_conversation`), **Catch up on recent changes** (`catch_up`), **Brief from the wiki**
(`research_brief`), **Tidy up a section** (`tidy_section`) and **Check a page for stale claims**
(`review_page`). Settings → Connect an AI assistant has a “Try asking” list of example requests.

Set a **conventions page** in Settings (or create the starter one) and every assistant reads it when
it connects, so it files things the way you like.

Images go exactly where the assistant asks: under a heading, at the end of a section, before or
after some text, in place of a placeholder like `[photo]`, or at the top or bottom of the page.

## Search

Typing in search (⌘K) matches titles and keywords instantly from D1. Press Enter for a full search,
which blends meaning-based results from AI Search with keyword results. AI Search includes 1,000
semantic queries a month; past that, or when it is unavailable, Nitrogen falls back to keyword
search and says so. Set the `SEMANTIC_SEARCH` variable to `off` to use keyword search only.

## Back up and restore

**Settings → Backup** downloads every page as one JSON file and can restore from one. Images stay in
R2.

## Change the password

Set a new `APP_PASSWORD` in the Cloudflare dashboard (**Workers & Pages → nitrogen → Settings →
Variables and Secrets**) or with `npx wrangler secret put APP_PASSWORD`. Everyone is signed out.

## Local development

```sh
npm install
cp .dev.vars.example .dev.vars    # then set APP_PASSWORD
npm run db:migrate:local
npm run dev
```

Local dev uses keyword search (AI Search only runs on Cloudflare). To use your deployed AI Search
index locally, sign in with `npx wrangler login` and run `N2_REMOTE=1 npm run dev`.

| Script                       | What it does                                       |
| ---------------------------- | -------------------------------------------------- |
| `npm run dev`                | Vite dev server with the Worker running in workerd |
| `npm run build` / `preview`  | Production build / serve the build locally         |
| `npm test`                   | Unit tests and Workers-runtime API and MCP tests   |
| `npm run typecheck` / `lint` | TypeScript, ESLint and Prettier                    |
| `npm run deploy`             | Build, migrate the remote database, then deploy    |
| `npm run release`            | Migrate, then deploy (the Workers Builds command)  |

### How it’s built

- **Cloudflare Workers** with static assets. **Hono** serves `/api`; **D1** stores pages, the tree,
  history, links and the FTS5 keyword index; **R2** stores images (served at `/files/…` to signed-in
  users); **AI Search** provides semantic search; **KV** holds MCP OAuth grants.
- **React**, **TypeScript**, **Vite**, **TanStack Query**, **React Router** and **CodeMirror 6**,
  installable as a PWA.
- See [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) and [docs/DECISIONS.md](docs/DECISIONS.md).

## Support

Nitrogen is free and built by [Tyler Class](https://tylerclass.net). If you want to say thank you, coffee is my love language: [ko-fi.com/tylerclass](https://ko-fi.com/tylerclass) ☕

## License

[MIT](LICENSE)
