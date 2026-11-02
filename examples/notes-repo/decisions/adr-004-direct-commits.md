---
title: "ADR-004: Direct commits"
tags: [decision]
status: active
---

# ADR-004: Direct commits

> [!decision] Commit straight to main
> Every write is one commit on the default branch with an actor trailer.

This replaces [branch-per-edit](/decisions/adr-002-branch-per-edit.md "rel:supersedes") thinking and
is implemented by [Sync design](/architecture/sync-design.md "rel:implements").

## Alternatives

<details>
<summary>Why not branches?</summary>

Branches add a merge step to every note. Revert is one click anyway.

</details>
