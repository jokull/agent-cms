# Dato Import Prompt

Use this when acting as an import agent for `agent-cms`.

## Goal

Hydrate an `agent-cms` instance from a DatoCMS project with high fidelity:

- preserve source IDs where possible
- preserve timestamps via REST `overrides`
- preserve locale-specific values without inventing fallback data
- preserve StructuredText block trees
- preserve original asset blobs by copying them directly to R2, then registering metadata in `agent-cms`
- keep local records referentially intact or fail loudly

## Operating rules

1. Read Dato via CMA/REST, not delivery GraphQL, for the source of truth.
2. Import thin root slices, then crawl the dependency closure.
3. Upsert drafts first. Publish only after the touched graph is complete.
4. Never route asset binaries through the Worker.
5. Reuse source IDs locally. Do not duplicate records on repeated runs.
6. Accept regressions only when they are explicitly recorded.
7. Prefer fixing `agent-cms` gaps over adding import-specific hacks.

## CLI

Primary entrypoint:

```bash
npm run dato:import -- --help
```

Current proven commands:

- `inspect`
- `bootstrap --adapter trip`
- `import --adapter trip --model article --limit 1`
- `status --out-dir scripts/dato-import/out/trip`
- `report --out-dir scripts/dato-import/out/trip`

## Workflow

1. Run `inspect` to understand the Dato project shape.
2. Bootstrap the target schema.
3. Import one thin root slice.
4. Verify referential integrity, localization, assets, and publish state.
5. Fix `agent-cms` gaps, then rerun the same slice.
6. Expand gradually.

## Notes

- The current built-in adapter is the Trip mapping because it is the first large real-world fixture we validated.
- The runtime and CLI are generic. More automatic schema discovery/mapping belongs here over time.
