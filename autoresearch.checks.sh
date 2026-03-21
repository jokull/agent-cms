#!/bin/bash
set -euo pipefail

# Build
npm run build --silent 2>&1 | tail -5

# Typecheck
npx tsc --noEmit --pretty false 2>&1 | tail -20

# Tests
npx vitest run --reporter=dot 2>&1 | tail -30

# Deploy blog example (picks up MCP changes)
cd examples/blog/cms
npx wrangler deploy 2>&1 | tail -10

# Verify deployed CMS
CMS_URL="${CMS_URL:-https://test-cms.solberg.is}"
sleep 3
curl -sf "${CMS_URL}/health" >/dev/null || { echo "Deploy verification failed"; exit 1; }
echo "Deploy verified OK"
