# Chat Agent — Testing & Prompt Tuning

The CMS chat agent lives at `POST /api/chat`. It uses Vercel AI SDK's `streamText()` with Workers AI (Llama 4 Scout) and a set of CMS tools.

## Architecture

```
src/http/chat-handler.ts    — system prompt, tools, streaming handler
src/http/router.ts          — /api/chat route wiring
packages/visual-edit-react/src/cms-agent.tsx — React UI component
```

The system prompt is in `SYSTEM_PROMPT` at the top of `chat-handler.ts`. Per-request context (record data, field definitions, markdown previews) is appended dynamically.

## Local setup

```bash
# Start CMS (needs AI binding — uses remote Workers AI)
cd examples/visual-edit/cms
npx wrangler dev --port 8787

# Start site
cd examples/visual-edit/site
npx astro dev --port 4321
```

After changing `chat-handler.ts`, rebuild before restarting wrangler:

```bash
pnpm run build
# Then restart wrangler (kill + re-run, or it hot-reloads)
```

If search returns no results, reindex:

```bash
curl -X POST http://localhost:8787/api/search/reindex \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer dev" \
  -d '{}'
```

## Testing prompts with curl

The chat endpoint accepts UIMessage format. Here's a template:

```bash
RECORD_ID="01KM0SDW2VKQ6NY08T0747PWS1"  # adjust to your record

curl -s -X POST http://localhost:8787/api/chat \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer dev" \
  -d "{
    \"messages\": [{
      \"id\": \"1\",
      \"role\": \"user\",
      \"parts\": [{\"type\": \"text\", \"text\": \"YOUR PROMPT HERE\"}]
    }],
    \"recordId\": \"$RECORD_ID\",
    \"modelApiKey\": \"page\"
  }"
```

### Useful grep patterns on the stream output

```bash
# Tool calls only
... | grep "tool-input-start" | sed 's/.*"toolName":"//;s/".*//'

# Errors
... | grep "tool-output-error"

# Text response (concatenated)
... | grep "text-delta" | sed 's/.*"delta":"//;s/"}$//' | tr -d '\n'

# Tool calls + errors + step boundaries
... | grep -E "tool-input-start|tool-output-error|finish-step"
```

### Reading server logs

Wrangler writes to stdout. If you redirect to a file:

```bash
npx wrangler dev --port 8787 > /tmp/wrangler-cms.log 2>&1 &
```

Then grep for `[chat]` prefixed log lines:

```bash
strings /tmp/wrangler-cms.log | grep "\[chat\]"
```

Key log lines:
- `[chat] request` — incoming message count, record context
- `[chat] pre-warmed with record` — system prompt size, field count
- `[chat] tool:*` — tool invocations with args
- `[chat] markdown input:` — markdown sent to update_structured_text
- `[chat] step finished` — per-step tool calls, results, finish reason

## Test battery

Run these 10 tasks to validate prompt changes. All should complete with 0 errors:

```bash
R="YOUR_RECORD_ID"

# 1. Simple field update
"Make the title shorter — just 3-4 words"

# 2. Locale sync
"Update the Icelandic title to match the English one"

# 3. Structured text rewrite
"Rewrite the English body to be more technical — mention APIs and webhooks"

# 4. Add formatting
"Add a bulleted list of 3 features to the English body"

# 5. Add image block (multi-step: list_assets → add_block_to_structured_text)
"Add an image block after the first paragraph. Use an image from the asset library."

# 6. Read-only query
"What images are available in the asset library?"

# 7. Remove blocks
"Remove all image blocks from the English body but keep the text"

# 8. Translation
"Translate the English body into Icelandic. Keep the same structure."

# 9. Shorten content
"Make the English body more concise — 2 paragraphs max"

# 10. Code block
"Add a code block showing a GraphQL query example to the English body"
```

Expected behavior per task:

| # | Expected tools | Notes |
|---|---------------|-------|
| 1 | update_record | Both locales if asked |
| 2 | update_record | Single locale |
| 3 | update_structured_text | Markdown with formatting |
| 4 | update_structured_text | Should contain `* ` list items |
| 5 | list_assets, add_block_to_structured_text | May waste 1 step parallelizing |
| 6 | list_assets | No writes |
| 7 | update_structured_text | Markdown without sentinels |
| 8 | update_structured_text | Different locale |
| 9 | update_structured_text | Shorter output |
| 10 | update_structured_text | Should contain ``` fenced block |

## Interlinking test

Requires blog_post records to be seeded and search indexes built:

```bash
"Search for content about 'agent CMS' and 'visual editing', then add internal links to the English body."
```

Expected: `find_linkable_content` → `update_structured_text` with `[text](itemLink:RECORD_ID)` links.

Verify links in the DAST:

```bash
curl -s "http://localhost:8787/api/records?modelApiKey=page" \
  -H "Authorization: Bearer dev" | python3 -c "
import sys, json
r = json.load(sys.stdin)[0]
doc = r['body']['en'].get('document', {})
def find(n):
    if isinstance(n, dict):
        if n.get('type') == 'itemLink':
            print(f'  itemLink: {n[\"item\"]} -> {[c.get(\"value\") for c in n.get(\"children\",[])]}')
        for v in n.values(): find(v)
    elif isinstance(n, list):
        for i in n: find(i)
find(doc)
"
```

## Known model behaviors (Llama 4 Scout)

- **Eager parallelization**: calls tools in parallel even when output of one is needed by another. Wastes 1 step but self-corrects. The prompt instruction "MUST call them in separate steps" helps but doesn't fully prevent it.
- **Placeholder IDs**: when parallelizing, uses `RECORD_ID_1` or `ASSET_ID` as placeholders. These fail validation, triggering a retry with real IDs.
- **Good at**: immediate tool calls, markdown formatting, following the pre-warmed context, self-correction after errors.
- **Struggles with**: sequential multi-step planning on first attempt.

## Prompt tuning tips

- The system prompt should be concise. Llama 4 Scout responds well to clear structure but ignores verbose instructions.
- Tool descriptions matter more than the system prompt for guiding tool usage. Keep descriptions short and include the expected input format.
- The pre-warmed context (appended per-request) is the most impactful part — it gives the model the record ID, field types, and current markdown source. If the model isn't doing something, check if the context provides enough information.
- Use `maxOutputTokens: 2048` (set in streamText) to avoid truncated JSON/markdown in tool call arguments.
- The `/no_think` directive is Qwen-specific — don't use it with Llama models.

## Switching models

Change the model string in `createChatHandler`:

```typescript
const model = workersai(options.model ?? "@cf/meta/llama-4-scout-17b-16e-instruct");
```

Models tested:
- `@cf/qwen/qwen3-30b-a3b-fp8` — works but truncates JSON output, needs `/no_think`, struggles with multi-step
- `@cf/meta/llama-3.3-70b-instruct-fp8-fast` — refuses to use tools
- `@cf/meta/llama-4-scout-17b-16e-instruct` — best balance of tool calling, output quality, and speed
