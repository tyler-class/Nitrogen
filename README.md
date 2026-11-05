# Nitrogen (N2)

A personal wiki you host yourself on Cloudflare. Pages live in a tree, bodies are markdown, images go
straight into the page, search understands meaning, and Claude can read and write it over MCP.

[![Deploy to Cloudflare](https://deploy.workers.cloudflare.com/button)](https://deploy.workers.cloudflare.com/?url=https://github.com/tyler-class/nitrogen)

- **A page tree.** Every page can hold subpages. Drag pages in the sidebar to reorder or nest them.
- **Markdown with wiki links.** `[[Page title]]` links pages and powers “Linked from” backlinks.
  Callouts (`> [!TIP]`), tables, task lists and code blocks render cleanly.
- **Images where you put them.** Paste, drop or pick an image in the editor; it uploads to R2 and its
  markdown lands at the cursor.
- **Semantic search.** Find pages by meaning and by keywords (Cloudflare AI Search + D1 full-text).
- **History.** Every page keeps earlier versions; restore any of them.
- **Claude and other assistants.** A built-in MCP server lets assistants search, read, create, edit
  and reorganize pages. Every assistant edit is saved in the history.
- **Yours.** It runs on your Cloudflare account; the free plan is enough for a personal wiki.

## Deploy

### One click

1. Click **Deploy to Cloudflare** above and sign in (a free account works).
2. Cloudflare copies this repo to your GitHub or GitLab account, creates the database (D1), image
   storage (R2) and sign-in store (KV), and asks for **APP_PASSWORD**, the password you’ll sign in
   with. Pick something long.
3. Open the `*.workers.dev` link when the deploy finishes and sign in.

The deploy command (`npm run deploy`) builds the app, deploys the Worker and applies the database
migrations. Semantic search needs no setup: Nitrogen creates its AI Search index the first time it
saves a page.

### By hand

```sh
git clone https://github.com/tyler-class/nitrogen.git && cd nitrogen
npm install
npx wrangler login
npm run deploy
npx wrangler secret put APP_PASSWORD
```

Wrangler creates the D1 database, R2 bucket and KV namespace on the first deploy.

## Connect Claude

In Nitrogen, open **Settings → Connect an AI assistant** and copy your MCP URL
(`https://<your-nitrogen>/mcp`).

- **Claude (web, desktop, mobile):** Settings → Connectors → Add custom connector → paste the URL.
  Approve with your wiki password.
- **Claude Code:** `claude mcp add --transport http nitrogen https://<your-nitrogen>/mcp`

Tools: `get_tree`, `read_page`, `search`, `create_page`, `create_pages` (a whole subtree at once),
`edit_page` (find/replace, section edits, append), `update_page`, `move_page`, `delete_page`
(confirmed by title), `list_revisions`, `read_revision`, `restore_revision`, `add_image` (import
from a URL and place it in a page).

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
| `npm run deploy`             | Build, deploy, migrate the remote database         |

### How it’s built

- **Cloudflare Workers** with static assets. **Hono** serves `/api`; **D1** stores pages, the tree,
  history, links and the FTS5 keyword index; **R2** stores images (served at `/files/…` to signed-in
  users); **AI Search** provides semantic search; **KV** holds MCP OAuth grants.
- **React**, **TypeScript**, **Vite**, **TanStack Query**, **React Router** and **CodeMirror 6**,
  installable as a PWA.
- See [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) and [docs/DECISIONS.md](docs/DECISIONS.md).

## License

[MIT](LICENSE)
