# Nitrogen index action

Runs `nitrogen index` (full parser, no Worker CPU limit) on every push and posts HMAC-signed row
batches to the Worker's `/admin/ingest`. This is the source of index correctness; webhooks and
the Worker's own commits keep it fresh in between.

```yaml
- uses: actions/checkout@v4
- uses: tyler-class/nitrogen/action@v0
  with:
    worker-url: ${{ vars.NITROGEN_URL }}
    ingest-secret: ${{ secrets.NITROGEN_INGEST_SECRET }}
```

`dist/nitrogen.mjs` is built with `pnpm --filter @nitrogen/action build` and committed on release.
