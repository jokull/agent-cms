# Trip Migration Lab

Local-only migration target for importing small read-only slices from `~/Code/trip` and DatoCMS into agent-cms.

Deep-dive notes and current findings live in [`docs/migrations/trip.md`](../../docs/migrations/trip.md).
Canonical import architecture lives in [`docs/migrations/dato-import.md`](../../docs/migrations/dato-import.md).

Start the local worker:

```bash
cd examples/trip-migration/cms
npx wrangler dev --local --port 8791 --persist-to .wrangler/state-v3
```

Then run the importer from the repo root with:

```bash
DATOCMS_API_TOKEN=... pnpm run dato:import -- inspect
CMS_URL=http://127.0.0.1:8791 DATOCMS_API_TOKEN=... pnpm run dato:import -- bootstrap --adapter trip
CMS_URL=http://127.0.0.1:8791 DATOCMS_API_TOKEN=... IMPORT_LOCALE=en pnpm run dato:import -- import --adapter trip --model article --limit 1
```

The migration scripts upload original asset blobs directly into the local Miniflare R2 bucket, then register asset metadata through the CMS API.

This environment is disposable. Do not point the scripts at a shared or deployed CMS.
