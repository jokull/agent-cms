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
ADMIN_MCP_CONFIG="${BLOG_DIR}/.mcp-autoresearch-admin.json"
TOKEN_FILE="${SCRIPT_DIR}/.autoresearch-editor-token"
CLAUDE_MAX_BUDGET_USD="${CLAUDE_MAX_BUDGET_USD:-2.00}"

# --- Verify CMS is reachable ---
if ! curl -sf "${CMS_URL}/health" >/dev/null 2>&1; then
  echo "METRIC success=0"
  echo "METRIC friction_count=99"
  echo "CMS not reachable at ${CMS_URL}" >&2
  exit 1
fi

# --- Reset database to known state (scientific method: same starting conditions) ---
# Drop all content/block/fts tables, re-setup, re-seed
echo "Resetting CMS database..." >&2
TABLES=$(curl -sf "${CMS_URL}/mcp" \
  -X POST \
  -H "Content-Type: application/json" \
  -H "Accept: application/json, text/event-stream" \
  -H "Authorization: Bearer ${CMS_WRITE_KEY}" \
  -d '{"jsonrpc":"2.0","method":"tools/call","params":{"name":"schema_info","arguments":{}},"id":1}' 2>/dev/null || echo "")

# Wipe via D1 — drop content tables, block tables, FTS tables, system metadata
cd "$SCRIPT_DIR/examples/blog/cms"
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

cd "$SCRIPT_DIR"

# Re-initialize and re-seed
curl -sf "${CMS_URL}/api/setup" -X POST -H "Content-Type: application/json" -H "Authorization: Bearer ${CMS_WRITE_KEY}" >/dev/null 2>&1 || true
CMS_URL="${CMS_URL}" npx tsx examples/blog/seed.ts >/dev/null 2>&1
echo "CMS reset complete." >&2

# --- Invalidate stale editor token (DB was wiped) ---
rm -f "$TOKEN_FILE"

# --- Get or create editor token ---
EDITOR_TOKEN=""
if [ -f "$TOKEN_FILE" ]; then
  EDITOR_TOKEN=$(cat "$TOKEN_FILE")
  VERIFY=$(curl -sf "${CMS_URL}/mcp/editor" \
    -X POST \
    -H "Content-Type: application/json" \
    -H "Accept: application/json, text/event-stream" \
    -H "Authorization: Bearer ${EDITOR_TOKEN}" \
    -d '{"jsonrpc":"2.0","method":"initialize","params":{"protocolVersion":"2025-03-26","capabilities":{},"clientInfo":{"name":"verify","version":"0.1"}},"id":1}' 2>/dev/null || echo "")
  if ! echo "$VERIFY" | grep -q "agent-cms"; then
    EDITOR_TOKEN=""
  fi
fi

if [ -z "$EDITOR_TOKEN" ]; then
  RESP=$(curl -sf "${CMS_URL}/mcp" \
    -X POST \
    -H "Content-Type: application/json" \
    -H "Accept: application/json, text/event-stream" \
    -H "Authorization: Bearer ${CMS_WRITE_KEY}" \
    -d '{"jsonrpc":"2.0","method":"tools/call","params":{"name":"editor_tokens","arguments":{"action":"create","name":"autoresearch","expiresIn":86400}},"id":1}')

  EDITOR_TOKEN=$(echo "$RESP" | python3 -c "
import json, sys
data = json.loads(sys.stdin.read())
if isinstance(data, list): data = data[0]
text = data.get('result', {}).get('content', [{}])[0].get('text', '')
try: print(json.loads(text).get('token', ''))
except: print('')
" 2>/dev/null)

  if [ -n "$EDITOR_TOKEN" ] && [[ "$EDITOR_TOKEN" == etk_* ]]; then
    echo "$EDITOR_TOKEN" > "$TOKEN_FILE"
  else
    EDITOR_TOKEN="$CMS_WRITE_KEY"
  fi
fi

# --- Write MCP configs ---
cat > "$MCP_CONFIG" <<EOF
{
  "mcpServers": {
    "blog-cms": {
      "type": "http",
      "url": "${CMS_URL}/mcp/editor",
      "headers": {
        "Authorization": "Bearer ${EDITOR_TOKEN}"
      }
    }
  }
}
EOF

cat > "$ADMIN_MCP_CONFIG" <<EOF
{
  "mcpServers": {
    "blog-cms": {
      "type": "http",
      "url": "${CMS_URL}/mcp",
      "headers": {
        "Authorization": "Bearer ${CMS_WRITE_KEY}"
      }
    }
  }
}
EOF

# --- Run claude with editor MCP ---
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
You are evaluating the output of a Claude agent that was given an editorial task
to perform via the agent-cms Editor MCP interface.

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
(retrying the same thing), not knowing which tool to use.

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
