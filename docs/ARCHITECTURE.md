# Architecture

```
PWA (React, IndexedDB drafts) ──cookie──▶ Worker "nitrogen" ──installation token──▶ GitHub notes repo
Claude (MCP over OAuth 2.1)  ──bearer──▶   /api /mcp /auth /oauth /hooks /admin       (single source of truth)
                                           D1: index cache (pages, links, headings, FTS5, activity)
                                           KV: OAuth provider state only
GitHub Action (full parser) ──HMAC──▶ /admin/ingest
```

## Packages

| Package | Role |
|---|---|
| `packages/spec` | SPEC.md, JSON schemas, conformance fixtures (`*.in.md`, goldens). |
| `packages/core` | Format engine. `@nitrogen/core` = full mode (remark); `@nitrogen/core/light` = line scanner + everything that does not need remark (used by the Worker). |
| `packages/cli` | `nitrogen` / `n2`: lint, normalize, export, index, fix-links, setup, doctor. |
| `packages/testing` | Fake GitHub (real git object ids) used by Worker and CLI tests. |
| `apps/worker` | Cloudflare Worker: API, MCP, auth, webhook, ingest. |
| `apps/web` | The PWA. |
| `action` | Composite GitHub Action: full reindex and optional standard-markdown mirror. |

## Worker request budget (free plan)

- Reads: page content comes from the Cache API by blob sha; D1 holds metadata. A cold page read is
  1 GitHub call.
- Commit: head, commit, tree (cached by sha), create tree (text inlined as `content`), create
  commit, update ref = 5-6 GitHub calls, + 1 per binary blob, + 1 per inbound page fetched for a
  move. Head moved -> retry (max 3).
- Freshness: `/api/changes` checks head at most every 15 s, diffs with `compare`, enqueues paths;
  `drain` indexes up to 20 per invocation (2 + N calls). Webhooks enqueue from the push payload
  without calling GitHub.

## Index correctness

1. Commits through the Worker update D1 in the same request (light scanner).
2. Webhook / polling enqueue changed paths; drained in bounded batches.
3. The Action posts full-parser rows to `/admin/ingest`; the last batch prunes deleted pages.
Rows carry blob shas; unchanged blobs are skipped.
