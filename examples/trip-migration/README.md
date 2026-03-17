# Trip Migration Lab

Local-only migration target for importing small read-only slices from `~/Code/trip` and DatoCMS into agent-cms.

Deep-dive notes and current findings live in [`docs/migrations/trip.md`](../../docs/migrations/trip.md).
Canonical import architecture lives in [`docs/migrations/dato-import.md`](../../docs/migrations/dato-import.md).

Start the local worker:

```bash
cd examples/trip-migration/cms
npx wrangler dev --local --port 8791 --persist-to .wrangler/state-v3
```

Then run the migration scripts from the repo root with:

```bash
CMS_URL=http://127.0.0.1:8791 DATOCMS_API_TOKEN=... node scripts/trip-migration/inspect.mjs
```

The migration scripts upload original asset blobs directly into the local Miniflare R2 bucket, then register asset metadata through the CMS API.

This environment is disposable. Do not point the scripts at a shared or deployed CMS.
