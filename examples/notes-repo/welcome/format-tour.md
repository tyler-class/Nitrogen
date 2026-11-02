---
title: Format tour
icon: book-open
order: 10
tags: [format, demo]
status: active
aliases: [CFM tour, Format reference]
---

# Format tour

Every Nitrogen construct on one page. See [Sync design](/architecture/sync-design.md#commit-flow "rel:cites")
for a real example.

## Links

A canonical link: [Home](/index.md). A typed link: [the decision](/decisions/adr-004-direct-commits.md "rel:implements").
An external link: [CommonMark](https://commonmark.org).

## Callouts

> [!note]
> A native GFM alert.

> [!warning]+ Foldable warning
> Expanded by default, but it can collapse.

> [!decision]- Collapsed decision
> Extended types degrade to a plain blockquote on GitHub.

## Toggle

<details>
<summary>Why source editing?</summary>

Because the file is **exactly** what you see in git.

</details>

## Drawer

:::drawer{title="Field reference" icon="table"}
| Field | Meaning |
| --- | --- |
| `title` | Page title |
:::

## Image

![Two atoms joined by a triple bond](/images/2026/11/n2.svg#align=right&w=200 "Figure 1: dinitrogen")

Text wraps around right aligned figures.

## Table

<!--nitrogen:table style=zebra header=sticky widths=30,20,50 caption="Sync states"-->
| State | Meaning | Action |
| :--- | :---: | ---: |
| Synced | Up to date | None |
| Queued | Waiting | Wait |

## Mermaid

```mermaid title="Commit flow"
flowchart LR
  A[PWA] --> B[Worker] --> C[(GitHub)]
```

## Tasks and footnotes

- [x] Write the spec
- [ ] Ship v0.1[^1]

[^1]: Soon.

Press <kbd>Cmd</kbd>+<kbd>K</kbd> to search. ~~Old idea~~.
