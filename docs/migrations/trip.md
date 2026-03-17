# Trip Migration

Local-only migration notes for moving read-only slices from `~/Code/trip` / DatoCMS into agent-cms.

## Current Status

- Local migration lab runs on Miniflare-backed D1/R2 at `examples/trip-migration/cms`
- Bootstrapped local schema and locales for a first content slice:
  - `location`
  - `article`
  - `guide`
  - supporting models: `contributor`, `place`, `tour`
  - supporting blocks: `image`, `video`, `table`, `tour_card`, `place_card`, `google_place_card`
- Imported successfully so far:
  - `location`: first `5`
  - `article`: first `13`
  - `guide`: first `13`

Verification after each batch is done with local GraphQL queries against the imported records.

## What Works

- Localized string/text fields import cleanly for the first English slice
- StructuredText imports cleanly for the supported block set above
- Linked support records are upserted as needed during import
- Source record IDs and asset IDs are preserved on import
- Re-imports are resumable because records are upserted and duplicate assets are tolerated
- Original asset blobs are uploaded directly to the local R2 bucket before asset metadata is registered in agent-cms
- Asset blob imports are resumable: if the local object already exists with the expected size, the importer reuses it instead of downloading it again
- English (`en`) thin slices now publish cleanly after dependency-ordered batch import
- Secondary locale passes (for example `ja`) merge localized values into draft records without auto-publishing
- Draft GraphQL preview resolves merged secondary-locale values correctly with `Accept-Language` + `X-Include-Drafts: true`
- Root `article`, `guide`, `location`, and `place` reads now come from Dato CMA raw items instead of page-shaped delivery queries

## Accepted Regressions

- `article.seo_metadata` and `guide.seo_metadata` are imported as `en`-only SEO data for now
- `VideoRecord` blocks are imported as plain `video_url` strings
- Imported block IDs are scoped to the parent record during import
  - Reason: some Dato block IDs are reused across records, while local block rows are owned rows with unique IDs
- Unsupported block references are dropped from imported DAST when no block payload is available in the current import slice

## Known Gaps

- Some imported assets still fall back to metadata-only registration when the source blob copy fails
- Localized SEO is still not modeled at full fidelity
- Dato site settings are not imported yet
- Source user provenance IDs are not stored yet

## Fixes Made During This Migration

- agent-cms now accepts caller-provided record IDs on create/bulk create
- agent-cms now accepts caller-provided asset IDs on create
- asset ingestion is now explicitly out-of-band: upload to R2 first, then register metadata in agent-cms
- migration publishes only the default-locale pass automatically; secondary locale passes defer publish and only merge localized draft values
- migration now enriches assets from the Dato CMA upload endpoint before copying the original blob into local R2
- local asset ingestion now writes directly into Miniflare R2 instead of shelling out through `wrangler r2 object put`
- migration helpers now normalize nullable locale/SEO/asset payloads to the API shapes agent-cms expects
- importer now scopes block IDs per parent record and rewrites DAST block references accordingly
- agent-cms now preserves source timestamps through the REST `overrides` envelope during import

## Next Likely Steps

- Import localized SEO for the migrated wedge
- Import Dato site settings into agent-cms site settings / `_site`
- Widen `article`, `guide`, and `place` slices after the asset transport is deterministic
