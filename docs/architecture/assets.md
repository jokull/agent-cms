# Asset Architecture

agent-cms separates asset ingestion from asset registration.

## The Model

There are two distinct concerns:

1. Binary storage in R2
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
- `r2Key`

The bucket owns the original file bytes.

## Canonical Flow

The intended asset flow is:

1. Upload the original binary to R2
2. Register or replace the asset in agent-cms via `/api/assets`
3. Serve the asset from `/assets/:id/:filename`
4. Apply Cloudflare Image Resizing at read time

This means agent-cms does **not** accept binary uploads through the Worker.

## Why

Workers are a good delivery boundary, but not the right default ingestion boundary for original binaries:

- large or bursty uploads are better handled directly by object storage
- multipart/resumable upload support already exists at the R2/S3 layer
- large or bursty binary ingestion is better handled out of band
- direct-to-R2 uploads are simpler and more operationally reliable
- it keeps the CMS API focused on metadata and content, not file streaming

This is a deliberate architecture choice, not a temporary limitation.

## Recommended Ingestion Paths

### Local Development

For local Miniflare-backed development, the preferred target is the local R2 bucket itself, accessed programmatically.

Why:

- Miniflare exposes R2 buckets directly for tests and local tooling
- it avoids repeated `wrangler` subprocess churn
- it is easier to make deterministic and resumable for bulk imports

The trip migration harness now uses this direct Miniflare R2 path.

### Deployed Imports

For deployed or one-off backend import tooling, the preferred path is the R2 S3-compatible API.

Why:

- it is the native path for direct object ingestion into R2
- it supports standard S3 tooling and SDKs
- multipart upload is available for larger binaries
- it keeps the CMS Worker out of the binary data path

### Editor / Agent Uploads

The future editor-facing path is signed direct upload:

1. authenticated client asks agent-cms for an upload grant
2. client uploads the original binary directly to R2
3. client registers the asset metadata in agent-cms

That keeps the same architecture while avoiding direct R2 credentials for editor agents.

## MCP / Agent Usage

Agent tools should guide users through:

1. putting the object into R2
2. calling the asset registration tool with the resulting `r2Key`

## Future Re-evaluation

If this proves to be a poor developer or editor experience, the ingestion path can be revisited later.

For now, direct-to-R2 upload plus metadata registration is the canonical asset lifecycle in agent-cms.

## Cloudflare References

- R2 S3-compatible API: <https://developers.cloudflare.com/r2/api/s3/api/>
- R2 presigned URLs: <https://developers.cloudflare.com/r2/api/s3/presigned-urls/>
- Miniflare R2 storage: <https://developers.cloudflare.com/workers/testing/miniflare/storage/r2/>
- Workers observability config: <https://developers.cloudflare.com/workers/observability/logs/workers-logs/#enable-workers-logs>
