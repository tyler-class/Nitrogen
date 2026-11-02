# Decisions (ADR log)

Format: number, date, decision, alternatives, why. Newest at the bottom.

## ADR-001 (2026-11-02) Toolchain versions
- **Decision:** TypeScript `~6.0`, Vitest `^4.1`, ESLint 10 + typescript-eslint 8, pnpm 10, Node 22.
- **Alternatives:** TypeScript 7.0 (Go port, `latest` on npm today); Vitest 5.
- **Why:** typescript-eslint 8 declares `typescript <6.1`; `@cloudflare/vitest-pool-workers` declares
  `vitest ^4.1`. Picking the newest versions the ecosystem actually supports avoids peer breakage.

## ADR-002 (2026-11-02) Workspace packages export TypeScript source
- **Decision:** internal packages set `exports` to `./src/*.ts`; `publishConfig.exports` points to
  `dist` for the npm-published packages (`@nitrogen/core`, `@nitrogen/cli`).
- **Alternatives:** project references + `tsc -b` emitting to dist for every package; custom export
  condition.
- **Why:** Vite, Vitest, Wrangler (esbuild) and tsx all consume TS directly, so there is no build
  step in the inner loop and no stale-dist bugs. Publishing builds with esbuild.

## ADR-003 (2026-11-02) SPEC.md clarifications beyond the brief
- **Decision:** SPEC.md copies section 5 of the brief and adds normative detail where the brief was
  ambiguous: a precise frontmatter grammar, case-insensitive title/alias matching for wikilinks,
  page-relative links accepted as input, canonical image fragment key order, E009/E010 being
  write-time checks, and E008 covering any raw HTML outside the allowlist.
- **Why:** the light scanner and the full parser must agree; that requires a grammar, not prose.

## ADR-004 (2026-11-02) One PageScan, two producers
- **Decision:** both parser modes produce the same `PageScan` structure (frontmatter, headings,
  links, images, wikilinks, callouts, drawers, table directives, HTML tags, toggles). Lint and index
  extraction are pure functions of `PageScan` + source, so they are shared code. Parity tests compare
  the full `PageScan` (deep equality) on every fixture and on 1,500 property-generated documents.
- **Alternatives:** separate lint implementations per mode; running remark inside the Worker.
- **Why:** parity becomes a single, testable contract instead of two rule engines drifting apart.
  Plain-text helpers (body, excerpt, link context) are line-based and identical in both modes by
  construction; they are documented as lexical, not structural.
- **Known light-scanner limits:** headings inside list items, HTML block types 3-5, and exotic
  CommonMark edge cases (e.g. link destinations split by a blockquote prefix) are not modeled. They
  only affect index freshness until the full reindex (Action) runs.

## ADR-005 (2026-11-02) Text and leaf directives are not CFM
- **Decision:** after parsing, `textDirective` and `leafDirective` nodes are turned back into the
  exact source text. Only `:::drawer` container directives are CFM; other container names are kept
  as generic containers (rendered as their children, normalized untouched).
- **Why:** remark-directive otherwise eats ordinary prose (`10:30` became a directive named `30`).

## ADR-006 (2026-11-02) Normalizer works by source edits, in three stages
- **Decision:** normalization applies offset-based edits to the original text in three reparsed
  stages (leaves: links, images, table directives, HTML; then callouts and toggles; then drawers).
  It never re-serializes the AST.
- **Alternatives:** mdast -> remark-stringify.
- **Why:** stringify reformats everything (list markers, emphasis style, escapes, table padding),
  which destroys diffs and makes idempotency hard to prove. Source edits keep untouched markdown
  byte-identical; idempotency and fingerprint equality are property-tested.

## ADR-007 (2026-11-02) The GFM "lead title" convention for callouts
- **Decision:** GFM alerts cannot carry a title, so normalized output writes
  `> [!WARNING]\n> **Title**` and extended types as `> [!NOTE]\n> **Decision: Title**`. An
  uppercase native marker alone on its line, followed in the same paragraph by a bold-only line,
  is read back as a titled callout by the fingerprint, the commonmark normalizer, and the renderer.
  When a title-less callout's body starts with a bold-only line, the normalizer inserts a blank `>`
  line so the body is not misread as a title.
- **Why:** makes gfm output re-importable without loss and keeps normalize(gfm) -> normalize(cm)
  consistent.

## ADR-008 (2026-11-02) Canonical wikilink text
- **Decision:** `[[Target]]` becomes `[Target](/path.md)` (the text as written; the page title when
  the target was a path); `[[Target#Heading]]` becomes `[Target > Heading](/path.md#heading)`;
  a `|label` always wins.
- **Why:** mirrors Obsidian's display, keeps the author's wording.

## ADR-009 (2026-11-02) Commonmark profile details
- **Decision:** `<kbd>X</kbd>` -> `` `X` ``; `<br>` -> a space; `<sub>/<sup>` tags removed (text kept);
  HTML comments removed; toggles -> bold title paragraph + body; drawers -> titled blockquote. Task
  lists, footnotes, strikethrough and pipe tables are kept (documented exceptions; strict viewers
  show them as text).

## ADR-010 (2026-11-02) Ingest signature
- **Decision:** `/admin/ingest` requires `X-Nitrogen-Timestamp` (unix seconds) and
  `X-Nitrogen-Signature: sha256=<hex HMAC-SHA256(secret, "<timestamp>.<body>")>`; the Worker rejects
  timestamps older than 5 minutes. Batches carry `allPaths` so the final batch can prune deleted pages.
- **Why:** timestamped HMAC blocks replay; constant-time compare on the Worker.

## ADR-011 (2026-11-02) github-slugger is a runtime dependency of the light scanner
- **Decision:** depend on `github-slugger` (one 8 KB file, no dependencies) instead of
  re-implementing it. Anchors must match github.com exactly; a copy would drift.

## ADR-012 (2026-11-02) Verified free-tier limits (sources: Cloudflare and GitHub docs sources on GitHub, npm)
Cloudflare docs hosts were not reachable from the build sandbox; numbers were read from the
`cloudflare/cloudflare-docs` and `github/docs` source repos on 2026-11-02.
- **Workers Free:** 10 ms CPU/request (I/O wait excluded); 50 external subrequests + 1,000 to
  Cloudflare services per invocation; 100k requests/day; 128 MB memory; 64 MiB uncompressed bundle,
  no compressed limit. Static asset requests are free and unlimited, except paths routed through
  the Worker with `run_worker_first`.
- **D1 Free:** 5M rows read/day, 100k rows written/day, 500 MB/DB, 50 queries per invocation (a
  `batch()` counts as one and is one transaction), 100 bound params/query, 100 KB statements. FTS5
  is supported; D1 export fails with virtual tables (drop, export, recreate).
- **KV Free:** 100k reads, 1,000 writes/deletes/lists per day; 1 write/s/key; min TTL 60 s.
- **GitHub:** installation tokens last 1 h (format may be `ghs_APPID_JWT`, do not assume length);
  App JWT RS256, iat -60 s, exp <= 10 min; PEM is PKCS#1, wrapped to PKCS#8 for WebCrypto. Tree
  entries with `sha: null` delete; recursive trees truncate at 100k entries / 7 MB. GitHub Apps
  cannot be deleted via API. App user tokens expire after 8 h (we only use them once at login).
- **Consequences:** the light scanner in the Worker; GitHub calls budgeted per request (commit ~6
  calls + binaries + inbound pages); D1 writes always batched; blob cache uses the Cache API (free),
  not KV; rate limits counted in D1, not KV; KV is used only by the OAuth provider.

## ADR-013 (2026-11-02) No commit lock
- **Decision:** no KV or Durable Object lock around commits. The ref update is fast-forward only
  (compare-and-swap); on 422 the pipeline rebuilds on the new head, re-verifies base shas, and
  retries up to 3 times.
- **Why:** KV is eventually consistent and cannot implement a lock; a DO is unnecessary for one
  user. CAS on the ref is the real serialization point.

## ADR-014 (2026-11-02) FTS table stores its own text; pages has no body column
- **Decision:** `pages_fts` is a normal FTS5 table (with a `path UNINDEXED` column) instead of
  `content=''`; `pages` keeps the excerpt but not the full body.
- **Why:** contentless FTS5 cannot produce `snippet()` highlights, which search requires. Storing
  the body once (in FTS) instead of twice keeps the DB small.

## ADR-015 (2026-11-02) Stateless signed-cookie sessions
- **Decision:** PWA sessions are HMAC-signed cookies (`n2_session`, HttpOnly, Secure, SameSite=Lax,
  30-day sliding expiry, re-issued when older than a day). CSRF uses a double-submit token
  (`n2_csrf` cookie + `X-CSRF-Token` header) plus an Origin check. Login `state` is a signed cookie.
- **Alternatives:** opaque ids in KV.
- **Why:** zero KV writes per request on the free tier. Revocation = rotate `SESSION_SECRET`
  (`nitrogen rotate-keys`).

## ADR-016 (2026-11-02) MCP transport
- **Decision:** stateless streamable HTTP via `createMcpHandler` (`agents/mcp/server`) behind
  `@cloudflare/workers-oauth-provider` (single-Worker `OAuthProvider`), no Durable Objects.
- **Why:** `McpAgent` is deprecated; stateless keeps the free plan simple.
