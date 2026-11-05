# Architecture

```
PWA (React, CodeMirror) ──cookie──▶ Worker "nitrogen"
Claude (MCP over OAuth 2.1) ─bearer─▶  /api  /files  /mcp  /authorize  /oauth
                                       │
                                       ├─ D1   pages (tree + markdown), page_revisions, links,
                                       │       files, pages_fts (FTS5), settings, login_attempts
                                       ├─ R2   images: img/<id>.<ext>, referenced as /files/<key>
                                       ├─ AI Search  semantic index (instance SEARCH_INSTANCE in the
                                       │       account's "default" namespace, created at runtime)
                                       └─ KV   OAuth provider state only
```

## Code layout

| Path         | Role                                                                           |
| ------------ | ------------------------------------------------------------------------------ |
| `src/shared` | Types, zod schemas, markdown helpers (links, slugs, FTS query), tree, edit ops |
| `src/worker` | Worker: entry + OAuth, Hono API, pages service, search, images, MCP server     |
| `src/client` | React app                                                                      |
| `migrations` | D1 schema                                                                      |
| `test/logic` | Pure unit tests (Node)                                                         |
| `test/api`   | API and MCP tests in the Workers runtime                                       |

## Pages

- A page has `parent_id` (NULL = top level) and an integer `position` among its siblings. Moves and
  inserts renumber the new siblings in one batch. Moving into one's own subtree is refused.
- Writes carry `base_version`; the UPDATE is a compare-and-swap on `version`, so concurrent editors
  (the app's autosave, an assistant) get a 409 instead of silently overwriting each other.
- History: the version being replaced is snapshotted when an edit session starts (the page was idle
  for 10 minutes) and on every assistant edit; 100 snapshots are kept per page.
- Links: `[[Title]]` (case-insensitive, oldest page wins on duplicates) and `/p/<id>` links are
  extracted on save into `links` for backlinks.
- Deleting a page deletes its subtree; images that no remaining page references are deleted from R2.

## Search

- Keyword: `pages_fts` (FTS5, kept in sync by triggers) with bm25 weighting titles 8× the body.
  Queries are built from quoted words, so user input cannot inject FTS operators.
- Semantic: each page is uploaded to AI Search as `pages/<id>.md` (title, tree path, plain text).
  `indexed_version < version` marks pages that need (re)indexing; writes trigger indexing in
  `waitUntil`, and a cron every 15 minutes retries anything missed. Deleted pages' items are queued
  in `search_tombstones`.
- Hybrid results merge both lists with reciprocal rank fusion. If AI Search fails (local dev, quota,
  outage) the response falls back to keyword hits and carries `semantic_unavailable`.

## Free-plan budget

D1 allows 50 queries per Worker invocation on the free plan (a `batch()` counts as one), so
multi-row writes are batched, and `create_pages` writes a whole subtree in one batch.
