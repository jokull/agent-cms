#!/bin/bash
set -euo pipefail

# --- Config ---
CMS_URL="${CMS_URL:-https://test-cms.solberg.is}"
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
BLOG_DIR="${SCRIPT_DIR}/examples/blog"
DEV_VARS_FILE="${SCRIPT_DIR}/examples/blog/cms/.dev.vars"
if [ -z "${CMS_WRITE_KEY:-}" ] && [ -f "$DEV_VARS_FILE" ]; then
  # shellcheck disable=SC1090
  set -a
  source "$DEV_VARS_FILE"
  set +a
fi
CMS_WRITE_KEY="${CMS_WRITE_KEY:?Set CMS_WRITE_KEY env var}"
MCP_CONFIG="${BLOG_DIR}/.mcp-autoresearch.json"
CLAUDE_MAX_BUDGET_USD="${CLAUDE_MAX_BUDGET_USD:-2.00}"

# --- Verify CMS is reachable ---
if ! curl -sf "${CMS_URL}/health" >/dev/null 2>&1; then
  echo "METRIC success=0"
  echo "METRIC friction_count=99"
  echo "CMS not reachable at ${CMS_URL}" >&2
  exit 1
fi

# --- Reset database to empty state ---
echo "Resetting CMS database..." >&2
cd "$SCRIPT_DIR/examples/blog/cms"

# Drop dynamic tables (content_*, block_*, fts_*)
DYNAMIC_TABLES=$(npx wrangler d1 execute test-blog-cms-db --remote \
  --command "SELECT name FROM sqlite_master WHERE type='table' AND (name LIKE 'content_%' OR name LIKE 'block_%' OR name LIKE 'fts_%')" \
  --json 2>/dev/null | python3 -c "
import json, sys
try:
    d = json.load(sys.stdin)
    tables = [r['name'] for r in d[0]['results']]
    print('; '.join(f'DROP TABLE IF EXISTS \"{t}\"' for t in tables) + ';' if tables else '')
except: print('')
" 2>/dev/null)

if [ -n "$DYNAMIC_TABLES" ]; then
  npx wrangler d1 execute test-blog-cms-db --remote --command "$DYNAMIC_TABLES" 2>/dev/null
fi

# Wipe metadata tables
npx wrangler d1 execute test-blog-cms-db --remote --command "$(cat <<'SQLEOF'
DELETE FROM fields;
DELETE FROM fieldsets;
DELETE FROM models;
DELETE FROM assets;
DELETE FROM site_settings;
DELETE FROM record_versions;
DELETE FROM editor_tokens;
DELETE FROM _cms_migrations;
SQLEOF
)" 2>/dev/null

cd "$SCRIPT_DIR"

# Re-initialize (runs migrations on empty DB)
curl -sf "${CMS_URL}/api/setup" -X POST -H "Content-Type: application/json" -H "Authorization: Bearer ${CMS_WRITE_KEY}" >/dev/null 2>&1 || true
echo "CMS reset to empty state." >&2

# --- Write MCP config (admin — full access including schema mutation) ---
cat > "$MCP_CONFIG" <<EOF
{
  "mcpServers": {
    "cms": {
      "type": "http",
      "url": "${CMS_URL}/mcp",
      "headers": {
        "Authorization": "Bearer ${CMS_WRITE_KEY}"
      }
    }
  }
}
EOF

# --- Run claude with admin MCP ---
TASK_PROMPT="${1:?Pass the task prompt as argument}"
CLAUDE_JSON=$(mktemp)

cd "$BLOG_DIR"
claude -p \
  --mcp-config "$MCP_CONFIG" \
  --strict-mcp-config \
  --model sonnet \
  --permission-mode bypassPermissions \
  --max-budget-usd "$CLAUDE_MAX_BUDGET_USD" \
  --output-format json \
  "$TASK_PROMPT" < /dev/null > "$CLAUDE_JSON" 2>&1 || true

# --- Extract token usage from JSON output ---
CLAUDE_RESULT=$(python3 -c "
import json, sys
try:
    d = json.load(open('$CLAUDE_JSON'))
    print(d.get('result', ''))
except:
    # If JSON parse fails, the whole file is the text output
    print(open('$CLAUDE_JSON').read())
" 2>/dev/null)

CLAUDE_TOKENS=$(python3 -c "
import json, sys
try:
    d = json.load(open('$CLAUDE_JSON'))
    u = d.get('usage', {})
    input_t = u.get('input_tokens', 0) + u.get('cache_creation_input_tokens', 0) + u.get('cache_read_input_tokens', 0)
    output_t = u.get('output_tokens', 0)
    total = input_t + output_t
    cost = d.get('total_cost_usd', 0)
    turns = d.get('num_turns', 0)
    print(f'input={input_t} output={output_t} total={total} cost={cost:.4f} turns={turns}')
except:
    print('input=0 output=0 total=0 cost=0.0000 turns=0')
" 2>/dev/null)

# Parse token values for METRIC lines
INPUT_TOKENS=$(echo "$CLAUDE_TOKENS" | grep -o 'input=[0-9]*' | head -1 | cut -d= -f2)
OUTPUT_TOKENS=$(echo "$CLAUDE_TOKENS" | grep -o 'output=[0-9]*' | head -1 | cut -d= -f2)
TOTAL_TOKENS=$(echo "$CLAUDE_TOKENS" | grep -o 'total=[0-9]*' | cut -d= -f2)
COST_USD=$(echo "$CLAUDE_TOKENS" | grep -o 'cost=[0-9.]*' | cut -d= -f2)
NUM_TURNS=$(echo "$CLAUDE_TOKENS" | grep -o 'turns=[0-9]*' | cut -d= -f2)

# --- Build codex evaluation prompt ---
EVAL_PROMPT=$(mktemp)
EVAL_OUTPUT=$(mktemp)

cat > "$EVAL_PROMPT" <<'HEADER'
You are evaluating the output of a Claude agent that was given a CMS task
to perform via the agent-cms Admin MCP interface (full access: schema design,
content creation, publishing, assets).

The CMS starts empty each run — the agent must create models and fields
before creating content. This is by design.

HEADER

echo "## The task prompt given to Claude:" >> "$EVAL_PROMPT"
echo "" >> "$EVAL_PROMPT"
echo "$TASK_PROMPT" >> "$EVAL_PROMPT"
echo "" >> "$EVAL_PROMPT"
echo "## Claude's full output:" >> "$EVAL_PROMPT"
echo "" >> "$EVAL_PROMPT"
echo "$CLAUDE_RESULT" >> "$EVAL_PROMPT"
echo "" >> "$EVAL_PROMPT"

cat >> "$EVAL_PROMPT" <<'FOOTER'

## Your job:

Analyze the dialog above and output EXACTLY these lines (no other text):

METRIC success=<0 or 1>
METRIC friction_count=<number of friction points>
SUMMARY: <one-line summary of what happened>
FRICTION: <comma-separated list of friction points, or "none">
LEARNING: <one key learning about the MCP experience>

Friction points include: errors from MCP tools, confusing tool interfaces, unnecessary
tool calls, poor error messages, missing capabilities, wrong tool choices, excessive
round-trips, unclear field formats, schema discovery difficulties, wheels spinning
(retrying the same thing), not knowing which tool to use, wrong sequencing of
schema creation steps.

Schema design from scratch is expected — do NOT count "had to create models first"
as friction. DO count things like: creating fields in wrong order, needing to retry
because of missing validators, confusion about field types, etc.

Be honest and specific. If the task succeeded cleanly with no issues, friction_count=0.
FOOTER

# --- Have codex evaluate ---
codex exec \
  -c 'sandbox_permissions=["full-disk-access"]' \
  -o "$EVAL_OUTPUT" \
  - < "$EVAL_PROMPT" 2>/dev/null

# --- Output the evaluation metrics ---
if [ -s "$EVAL_OUTPUT" ]; then
  grep -E '^(METRIC|SUMMARY|FRICTION|LEARNING)' "$EVAL_OUTPUT" || cat "$EVAL_OUTPUT"
else
  if [ -s "$CLAUDE_RESULT" ]; then
    echo "METRIC success=1"
    echo "METRIC friction_count=0"
  else
    echo "METRIC success=0"
    echo "METRIC friction_count=5"
  fi
fi

# Token usage metrics (always emitted)
echo "METRIC input_tokens=${INPUT_TOKENS:-0}"
echo "METRIC output_tokens=${OUTPUT_TOKENS:-0}"
echo "METRIC total_tokens=${TOTAL_TOKENS:-0}"
echo "METRIC cost_usd=${COST_USD:-0}"
echo "METRIC num_turns=${NUM_TURNS:-0}"

# --- Output the full claude dialog for pi to see ---
echo ""
echo "=== CLAUDE DIALOG ==="
echo "$CLAUDE_RESULT"
echo "=== END DIALOG ==="

rm -f "$CLAUDE_JSON" "$EVAL_PROMPT" "$EVAL_OUTPUT"
