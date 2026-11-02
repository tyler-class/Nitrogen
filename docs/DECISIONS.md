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
