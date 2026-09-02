# Asset Architecture

agent-cms separates asset ingestion from asset registration.

## The Model

Two distinct concerns:

1. Binary storage — **Cloudflare Images** for image assets, **R2** for other files
2. Asset metadata in D1

The CMS owns metadata:

- `id`
- `filename`
- `mimeType`
- `size`
- `width`
- `height`
- `alt`
- `title`
- storage locator: `imageId` + `imageDeliveryBase` (hosted images) or `r2Key` (files)

The storage provider owns the original file bytes.

## Why not R2 S3-compatible signing?

R2 direct uploads only exist via S3 SigV4 presigned URLs, which require the Worker to hold an
R2 API token (access key ID + secret) at runtime. Those credentials are per-instance secrets:
rotation, distribution, and scoping cost. The Cloudflare Images binding removes them entirely —
`IMAGES.hosted.createDirectUpload()` mints a one-time upload URL with the binding's own
permissions, so the CMS holds **no storage signing credentials** and image bytes never pass
through the Worker.

## Canonical Flow

1. **Images** (`image/*`): the CMS mints a one-time upload URL via the Images binding
   (`POST /api/assets/upload-url`, MCP `create_asset_upload_url`); the client uploads straight
   to Cloudflare (multipart form POST, field `file`); the client registers metadata with the
   returned `imageId` + `deliveryBase`. Delivery is `https://imagedelivery.net/<hash>/<imageId>/<variant>`.
2. **Other files**: upload via `import_asset_from_url` (server-side fetch → R2 put) or the
   worker-mediated `PUT /api/assets/:id/file` route, then register with the returned `r2Key`.

This is a deliberate architecture choice: direct-to-storage ingestion (no Worker byte proxy for
images) plus metadata registration.

## Why

- large or bursty uploads are better handled directly by the storage provider
- binding-minted upload URLs avoid holding S3 signing keys anywhere
- it keeps the CMS API focused on metadata and content, not file streaming
- image delivery gets Cloudflare's edge pipeline (variants, caching) for free

## Recommended Ingestion Paths

### Images (browser / editor / agents)

Keyless direct upload:

1. authenticated client calls `POST /api/assets/upload-url` (or MCP `create_asset_upload_url`)
2. client uploads the image bytes directly to the returned URL
   (multipart form POST, field `file`)
3. client registers metadata with the returned `assetId`, `imageId`, and `deliveryBase`

Requires an Images binding + a paid Cloudflare Images plan.

### Other files (PDFs, video, archives)

Server-side: `import_asset_from_url` (fetch → R2 put → register) or
`PUT /api/assets/:id/file` (worker-mediated R2 put) followed by metadata registration.
Requires the R2 bucket binding. These are rare relative to images, so bytes through the
Worker are acceptable here.

### Local Development

Miniflare exposes R2 buckets directly for tests and local tooling; the Images binding has no
local emulator, so image paths run against an in-memory fake binding in the test suite
(`test/fake-images.ts`) and the real binding in deployed Workers (`wrangler dev` / production).

## URL Resolution

One choke point (`resolveAssetUrl` in `src/media-field.ts`):

- hosted-image rows → `<imageDeliveryBase>/<imageId>/<variant>` (self-contained, no config)
- file rows → `<ASSET_BASE_URL>/<r2Key>` or the Worker's `/assets/:id/:filename` route

## Cloudflare References

- Images binding (hosted images, direct creator uploads, signed URLs):
  <https://developers.cloudflare.com/images/storage/binding/>
- Images binding changes (September 2026):
  <https://developers.cloudflare.com/changelog/post/2026-09-02-images-binding-updates/>
- R2 S3-compatible API: <https://developers.cloudflare.com/r2/api/s3/api/>
- Miniflare R2 storage: <https://developers.cloudflare.com/workers/testing/miniflare/storage/r2/>
