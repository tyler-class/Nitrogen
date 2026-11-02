#!/usr/bin/env bash
# Start the full local stack for e2e: fake GitHub (9999) + wrangler dev (8787) serving the built PWA.
set -euo pipefail
cd "$(dirname "$0")/.."
pnpm --filter @nitrogen/web build >/dev/null
rm -rf apps/worker/.wrangler/state-e2e
(cd apps/worker && npx wrangler d1 migrations apply DB --local -c wrangler.e2e.jsonc --persist-to .wrangler/state-e2e >/dev/null)
npx tsx packages/testing/src/serve.ts --port 9999 --seed examples/notes-repo &
FAKE=$!
(cd apps/worker && npx wrangler dev -c wrangler.e2e.jsonc --port 8787 --ip 127.0.0.1 --persist-to .wrangler/state-e2e --show-interactive-dev-session=false) &
WR=$!
trap 'kill $FAKE $WR 2>/dev/null' EXIT
for i in $(seq 1 60); do curl -sf http://127.0.0.1:8787/api/health >/dev/null && break; sleep 1; done
echo "stack ready: http://127.0.0.1:8787"
wait
