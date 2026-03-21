#!/bin/bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
cd "$SCRIPT_DIR"

# Build root package (produces dist/ that examples/blog/cms consumes via file:../../..)
pnpm run build 2>&1 | tail -5

# Typecheck
npx tsc --noEmit --pretty false 2>&1 | tail -20

# Tests
npx vitest run --reporter=dot 2>&1 | tail -30

# Deploy blog example (bundles from root dist/ via the file: dependency)
cd examples/blog/cms
npx wrangler deploy 2>&1 | tail -10

# Verify deployed CMS is healthy
CMS_URL="${CMS_URL:-https://test-cms.solberg.is}"
for i in 1 2 3 4 5; do
  if curl -sf "${CMS_URL}/health" >/dev/null 2>&1; then
    echo "Deploy verified OK"
    exit 0
  fi
  sleep 2
done
echo "Deploy verification failed after 5 attempts" >&2
exit 1
