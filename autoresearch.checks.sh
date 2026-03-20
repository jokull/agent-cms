#!/bin/bash
set -euo pipefail
# Build (wrangler dev uses built output)
npm run build --silent 2>&1 | tail -5
# Typecheck
npx tsc --noEmit --pretty false 2>&1 | tail -20
# Tests
npx vitest run --reporter=dot 2>&1 | tail -30
