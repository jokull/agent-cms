# Dato Import

Import DatoCMS content into agent-cms with high fidelity.

## How it works

The importer auto-discovers the DatoCMS project schema via CMA — no manual adapters or hardcoded field mappings needed. Field types are mapped automatically (Dato `file` → agent-cms `media`, `structured_text` → `structured_text`, etc.), and records are imported with their full dependency closure (linked records, block references, assets).

## Workflow

```bash
# 1. Inspect the Dato project
npm run dato:import -- inspect

# 2. Generate the agent-cms schema from Dato
npm run dato:import -- codegen

# 3. Bootstrap: generate + import schema into agent-cms
npm run dato:import -- bootstrap

# 4. Import records by model, expanding dependencies automatically
npm run dato:import -- import --model article --limit 5

# 5. Check status / findings
npm run dato:import -- status
npm run dato:import -- report
```

## What gets preserved

- Source record IDs (reused in agent-cms)
- Timestamps via REST `overrides` (createdAt, updatedAt, publishedAt)
- Locale-specific values without inventing fallback data
- StructuredText block trees with scoped block IDs
- Asset blobs copied directly to R2, then registered in agent-cms
- Referential integrity across linked records

## Environment

```
DATOCMS_API_TOKEN    Dato CMA read token
CMS_URL              agent-cms base URL (default: http://127.0.0.1:8791)
CMS_WRITE_KEY        agent-cms write key
```

## Architecture

```
core/
  datocms.mjs          — DatoCMS CMA client (items, uploads, site)
  agent-cms.mjs        — agent-cms REST client (models, fields, records, assets)
  local-r2.mjs         — Local R2 via Miniflare for asset storage
  schema-codegen.mjs   — Auto-generate ImportSchemaInput from Dato CMA
  field-transforms.mjs — Generic field value transforms (media, links, DAST, SEO, etc.)
  generic-import.mjs   — Record import with dependency crawling, checkpoints, findings
  runtime.mjs          — Filesystem and CLI helpers
commands/
  inspect.mjs          — Schema inspection
  status.mjs           — Checkpoint status
  report.mjs           — Findings summary
cli.mjs                — Effect CLI entry point
```
