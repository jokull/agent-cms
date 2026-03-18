# Dato Import

Canonical notes for importing content from DatoCMS into agent-cms.

The importer now lives in this repo as a first-class product surface. It is aimed at Dato users who want to hydrate an `agent-cms` instance with high enough fidelity that existing frontend queries can continue to work with minimal rewrites.

Primary entrypoint:

```bash
npm run dato:import -- --help
```

Current proven commands:

```bash
npm run dato:import -- inspect
npm run dato:import -- bootstrap --adapter trip --cms-url http://127.0.0.1:8791
npm run dato:import -- import --adapter trip --model article --limit 1 --locale en
npm run dato:import -- status --out-dir scripts/dato-import/out/trip
npm run dato:import -- report --out-dir scripts/dato-import/out/trip
```

The runtime and CLI are generic. The built-in `trip` adapter is the first real-world validation wedge while broader automatic schema discovery and mapping are generalized.

## Goals

The import should preserve:

- record IDs where possible
- asset IDs where possible
- locale-specific field values
- StructuredText block trees
- source timestamps:
  - `_created_at`
  - `_updated_at`
  - `_published_at`
  - `_first_published_at`
- enough metadata for high-fidelity frontend rendering

The import should avoid:

- inventing localized values through fallback at import time
- publishing half-imported dependency graphs
- routing original binary ingestion through the Worker
- creating fake “user systems” just to preserve Dato editor IDs

## Source of Truth

Use Dato CMA / REST as the source of truth for import.

Why:

- localized fields come back as real locale maps
- linked records come back as item IDs
- assets come back as upload references
- StructuredText block references can be resolved as raw block items
- site-level metadata is available from the site API

Do not rely on Dato GraphQL delivery queries as the primary import source for multi-locale migration. Delivery queries are useful for parity checks, but they are the wrong abstraction for raw import because fallback semantics can hide whether a locale value is real or inherited.

## Write Path

All writes go through the agent-cms REST API.

The importer should:

1. read raw Dato source data
2. build a dependency graph
3. upsert records through REST as drafts
4. publish only after a batch is internally complete

This keeps the import path aligned with normal CMS semantics instead of bypassing the application layer.

## Import Modes

There are two valid import modes, with different goals.

### Resumable correctness-first mode

This is the default migration mode.

Properties:

- works against a non-empty local target
- reuses preserved source IDs
- upserts records through the normal REST path
- publishes only after the touched subgraph is complete
- supports repeated thin-slice runs while fixing parity issues

This is the right mode while the importer and CMS are still being healed against real source data.

### Clean-slate bulk mode

This is a later optimization mode for one-time imports into an empty target.

Properties:

- assumes an empty CMS instance
- can defer publish and referential checks until the end of a batch or full import
- can insert drafts faster than the normal upsert path
- must run an explicit post-load integrity pass before publish

This can be faster, but it is not automatically safer. It only becomes safer when the target is known-empty and the integrity pass is strict.

Current guidance:

- keep the REST-driven resumable path as the canonical correctness lane
- add clean-slate bulk mode only after the field mapping and dependency rules are stable

## Import Order

Import by dependency order, leaves first, then inward toward the trunk.

For the current built-in `trip` adapter, that means:

1. `contributor`
2. `location`
3. `place`
4. `tour`
5. `article`
6. `guide`

Block rows are not imported independently. They are materialized as part of StructuredText import.

## Locales

Import locales explicitly, one pass at a time.

Rules:

- only write a locale key when the source actually has a value for that locale
- do not synthesize locale values from fallback behavior
- non-default locale passes merge into draft content only
- default locale pass is the one allowed to auto-publish

This avoids both orphaned localizations and fake translations.

## StructuredText

StructuredText import works as:

1. read the locale-specific DAST document from Dato CMA
2. walk block references in the DAST
3. fetch each referenced block item from Dato CMA
4. map block item types into local block models
5. recursively resolve nested StructuredText inside blocks
6. write the field through the normal agent-cms StructuredText path

This preserves the actual content tree instead of flattening page queries into an approximation.

## Assets

Asset import has two separate concerns:

1. original blob ingestion
2. asset metadata registration

The canonical flow is:

1. fetch the Dato upload record from the CMA
2. fetch the original asset URL from Dato
3. copy the original bytes directly into R2
4. register asset metadata in agent-cms via `/api/assets`

Important rule:

- do not send original binaries through the Worker

That remains the right boundary even for imports.

## Best Binary Ingestion Path

### Local

For local Miniflare-backed imports, the best target is direct access to the local R2 bucket rather than repeated `wrangler r2 object put` subprocess calls.

Why:

- Miniflare exposes R2 buckets programmatically
- local storage is already Miniflare-backed when using `wrangler dev`
- direct bucket access avoids CLI process churn and the transient local upload failures seen with repeated `wrangler` subprocesses

This is now the preferred local import path for asset blobs.

### Deployed

For deployed import tooling, the right path is direct-to-R2 upload via the R2 S3-compatible API:

- R2 S3 API for backend/import tooling
- multipart upload for larger binaries or resumable copies
- signed upload handoff for editor/agent workflows later

The CMS still registers metadata after the object exists in R2.

## Asset Fidelity Rules

For a high-fidelity Dato import, the asset import should preserve:

- the original asset ID where possible
- the original blob bytes
- filename and MIME type
- width and height
- blurhash and palette metadata when available
- focal point metadata when available

If the blob copy fails, the importer should record that as an explicit finding. Metadata-only registration is acceptable as a temporary migration fallback, but not as the target state.

## Resumable Asset Ingestion

Asset import should be resumable independently from record import.

Minimum behavior:

- if the target object already exists in R2 and matches the expected size, reuse it
- verify the object exists after upload before marking the asset as copied
- register metadata even when the blob was reused from a previous partial run
- record explicit findings when the blob copy fails or verification fails

This lets asset ingestion survive interrupted local runs without forcing re-download of every previously copied blob.

## Timestamps

Import fidelity depends on preserving source chronology.

Use the REST API `overrides` envelope for:

- `createdAt`
- `updatedAt`
- `publishedAt`
- `firstPublishedAt`

These are import-time system artifacts, not content fields.

## Dato User IDs

Dato editor/user IDs are lower priority than content and timestamps.

Current guidance:

- do not build a first-class user system for import fidelity
- if needed, store source user IDs as simple imported metadata values or extra columns later

That is enough to preserve provenance without creating unnecessary system complexity.

For this project, the right shape is a low-priority source ID field or column, not a user subsystem.

## SEO

SEO is important for fidelity and should not remain a long-term regression.

Target state:

- preserve locale-specific SEO values from Dato
- preserve site-level fallback/global SEO
- preserve SEO image references where modeled

That means the importer should treat Dato SEO fields as real data, not as optional decoration.

## Site Object

The Dato site object matters for parity.

Import should account for:

- locales
- site name
- global SEO / fallback SEO
- favicon and site-level asset references
- social accounts where mapped in `site_settings`

agent-cms already has site settings and `_site` GraphQL support, so site import should map into that path rather than inventing a separate migration-only model.

## Observability

Import runs should emit enough state to answer:

- what root slice was requested
- what dependency closure was touched
- which assets were copied, reused, or failed
- whether publish was skipped or completed
- what accepted regressions remain

The CLI output directory is currently:

- generic runtime output: `scripts/dato-import/out`
- built-in Trip adapter output: `scripts/dato-import/out/trip`

See [`scripts/dato-import/PROMPT.md`](/Users/jokull/Code/agent-cms/scripts/dato-import/PROMPT.md) for the current agent workflow.

The import loop needs first-class observability because migration failures are often data-shape failures, not simple transport failures.

Minimum expectations:

- request IDs propagated through CMS REST writes
- structured logs for import failures and retries
- explicit findings written per batch
- Workers observability enabled in `wrangler.jsonc` for deployed environments

The import harness should assume partial failures happen and make them diagnosable.

## Current Priorities

Highest-value remaining work:

1. model localized SEO properly in the import schema/path
2. import Dato site-level settings into agent-cms site settings
3. optionally preserve Dato user IDs as low-priority provenance metadata
4. add a clean-slate bulk import lane after the current resumable path is stable

## Verification Rules

Every thin-slice import should verify:

- records exist with the expected IDs
- linked records exist before publish
- localized fields resolve correctly in draft preview
- published records keep source timestamps
- asset URLs serve bytes when blob copy succeeded
- findings are recorded explicitly when fidelity is intentionally deferred

## Cloudflare References

- R2 S3-compatible API: <https://developers.cloudflare.com/r2/api/s3/api/>
- R2 presigned URLs: <https://developers.cloudflare.com/r2/api/s3/presigned-urls/>
- Miniflare R2 storage: <https://developers.cloudflare.com/workers/testing/miniflare/storage/r2/>
- Workers Logs / observability config: <https://developers.cloudflare.com/workers/observability/logs/workers-logs/#enable-workers-logs>
