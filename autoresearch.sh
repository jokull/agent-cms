#!/bin/bash
set -euo pipefail

# --- Config ---
CMS_PORT="${CMS_PORT:-8787}"
CMS_URL="http://127.0.0.1:${CMS_PORT}"
EXTRA_POST_COUNT="${EXTRA_POST_COUNT:-24}"
BENCH_ITERATIONS="${BENCH_ITERATIONS:-3}"
BENCH_WARMUP="${BENCH_WARMUP:-1}"
SUITE="benchmarks/blog-query-suite-scale.json"

# --- Build first (wrangler dev uses built output) ---
npm run build --silent 2>&1 | tail -3

# --- Start wrangler if not running ---
NEED_SEED=0
if ! curl -sf "${CMS_URL}/health" &>/dev/null; then
  # Kill anything on the port
  lsof -ti:"${CMS_PORT}" 2>/dev/null | xargs kill -9 2>/dev/null || true
  sleep 1

  cd examples/blog/cms
  rm -rf .wrangler/state
  npx wrangler dev --local --port "${CMS_PORT}" &>/tmp/autoresearch-wrangler.log &
  echo $! > /tmp/autoresearch-wrangler.pid
  cd ../../..

  for i in $(seq 1 30); do
    if curl -sf "${CMS_URL}/health" &>/dev/null; then break; fi
    if [ "$i" -eq 30 ]; then
      echo "METRIC total_ms=999999"
      echo "Wrangler failed to start"
      exit 1
    fi
    sleep 1
  done

  # Initialize CMS system tables
  curl -sf "${CMS_URL}/api/setup" -X POST -H 'content-type: application/json' >/dev/null
  NEED_SEED=1
fi

# --- Seed if needed ---
if [ "$NEED_SEED" -eq 1 ]; then
  EXTRA_POST_COUNT="${EXTRA_POST_COUNT}" CMS_URL="${CMS_URL}" npx tsx examples/blog/seed.ts 2>&1 | tail -3
fi

# --- Wait for hot-reload after build ---
sleep 1

# --- Run benchmark ---
RESULT=$(BENCH_ITERATIONS="${BENCH_ITERATIONS}" BENCH_WARMUP="${BENCH_WARMUP}" \
  BENCH_SUITE="${SUITE}" CMS_URL="${CMS_URL}" \
  node scripts/bench-blog.mjs 2>&1)

echo "$RESULT"

# --- Parse (macOS-compatible) ---
TOTAL_MS=$(echo "$RESULT" | perl -nle 'print $1 if /median=([0-9.]+)/' | awk '{sum+=$1} END {printf "%.3f", sum}')
SQL_TOTAL=$(echo "$RESULT" | perl -nle 'print $1 if /sql=([0-9]+)/' | awk '{sum+=$1} END {printf "%d", sum}')
PREVIEW_DEEP_MS=$(echo "$RESULT" | grep 'deep.*preview' | perl -nle 'print $1 if /median=([0-9.]+)/' | awk '{sum+=$1} END {printf "%.3f", sum}')

echo ""
echo "METRIC total_ms=${TOTAL_MS}"
echo "METRIC sql_statements=${SQL_TOTAL}"
echo "METRIC preview_deep_ms=${PREVIEW_DEEP_MS}"
