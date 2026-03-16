# agent-cms

Fully featured agent-first CMS. Experimental.

A headless content management system designed to be driven by AI agents via MCP. Runs as a Cloudflare Worker backed by D1 and R2 in your own Cloudflare account. There is no hosted service.

Agents handle what CMS admin panels used to: defining schemas, uploading assets, interlinking content, managing draft/publish workflows. Point an MCP client at a Google Drive folder with drafts and images and let it handle the rest — proofreading, image uploading, link resolution, publishing. The traditional CMS UI is the bottleneck, not the content.

Content writers who use Claude Code, Cursor, or any MCP-capable tool can manage a full content operation without learning an admin interface. Developers get a typed GraphQL API with no vendor lock-in.

The structured text format is [DAST](https://www.datocms.com/docs/structured-text/dast), a robust open standard. Existing rendering components like [`react-datocms`](https://github.com/datocms/react-datocms), `vue-datocms`, and `datocms-svelte` work out of the box.

## Quick start

```bash
npm create agent-cms my-cms
cd my-cms
```

The scaffold creates a Cloudflare Worker, provisions a D1 database and R2 bucket, runs migrations, and installs dependencies. When it's done:

```bash
npm run dev
```

Connect Claude to the MCP server:

```json
{
  "mcpServers": {
    "my-cms": { "url": "http://localhost:8787/mcp" }
  }
}
```

Deploy to production:

```bash
npm run deploy
```

## Interfaces

### `/mcp` — Agent interface

MCP server with tools for schema management (create models, add fields, configure block types), content operations (CRUD, bulk insert, publish/unpublish, reorder), asset uploads, and schema import/export. This is the primary interface.

### `/graphql` — Content delivery

Read-only GraphQL API for frontends. Supports filtering, ordering, pagination, locale fallback, and draft previews via the `X-Include-Drafts` header.

```graphql
{
  all_posts(
    filter: { _status: { eq: "published" } }
    order_by: [_created_at_DESC]
    first: 10
  ) {
    id
    title
    slug
    cover_image {
      url
      width
      height
      alt
    }
    body {
      value
      blocks {
        ... on CodeBlockRecord {
          id
          code
          language
        }
      }
    }
  }
}
```

#### GraphQL naming conventions

Model `api_key` values (snake_case) map to GraphQL names:

| api_key | GraphQL type | Single query | List query | Meta query |
|---------|-------------|-------------|------------|------------|
| `blog_post` | `BlogPost` | `blog_post` | `all_blog_posts` | `_all_blog_posts_meta` |
| `category` | `Category` | `category` | `all_categories` | `_all_categories_meta` |

Block types get a `Record` suffix: `code_block` → `CodeBlockRecord`.

Field `api_key` values stay snake_case in queries: `cover_image`, `published_at`.

#### MCP resources and prompts

Agents connecting via MCP get two resources for upfront context:
- **`agent-cms://guide`** — workflow order, naming conventions, field value formats, and lifecycle summary
- **`agent-cms://schema`** — current schema (models, fields, locales) as JSON

Two prompts encode common multi-step workflows:
- **`setup-content-model`** — design and create content models from a description
- **`generate-graphql-queries`** — generate correctly-typed GraphQL queries for a model

### `/api` — REST admin

JSON REST API for programmatic content management. Models, fields, records, assets, locales, publish/unpublish, bulk operations, schema import/export.

### `/api/search` — Search

Fulltext search powered by SQLite FTS5 with BM25 ranking and snippets. Records are automatically indexed on create, update, and delete. Searches across all models or scoped to a single model. Supports FTS5 query syntax including phrase matching.

```bash
curl -X POST https://my-cms.workers.dev/api/search \
  -d '{"query": "serverless computing", "modelApiKey": "post", "first": 10}'
```

Vector search via Cloudflare Vectorize provides semantic similarity — hybrid rank fusion combines keyword and vector results.

## Field types

| Type | Description |
|------|-------------|
| `string` | Single-line text |
| `text` | Multi-line text |
| `boolean` | True/false |
| `integer` | Whole number |
| `float` | Decimal number |
| `date` | Date without time |
| `date_time` | Date with time |
| `slug` | URL slug, auto-generated from a source field |
| `media` | Single file/image with metadata |
| `media_gallery` | Multiple files/images |
| `link` | Reference to another record |
| `links` | References to multiple records |
| `structured_text` | Rich text (DAST) with embedded blocks |
| `seo` | Composite: title, description, image |
| `json` | Arbitrary JSON |
| `color` | Color value |
| `lat_lon` | Geographic coordinates |

## Structured text

The structured text field stores content as DAST. Block types are defined per-model and embedded within the document tree — code blocks, CTAs, image galleries, whatever you need. Render with existing libraries:

- **React**: `react-datocms` `<StructuredText>` component
- **Vue**: `vue-datocms`
- **Svelte**: `datocms-svelte`
- **Astro**: Direct DAST traversal or any of the above

## Draft and publish

Records start as drafts. Publishing captures a snapshot — edits to the draft don't affect the published version until you publish again. The GraphQL API serves published content by default; pass `X-Include-Drafts: true` to preview draft state.

## Localization

Define locales with fallback chains. Localized fields store a value per locale. The GraphQL API respects the `Accept-Language` header and falls back through the chain when a locale is missing.

## Bindings

Only `DB` is required. Everything else is optional — each binding unlocks capabilities that gracefully degrade when absent.

| Binding | Type | What it enables |
|---------|------|-----------------|
| `DB` | D1 | **Required.** Content storage, schema, FTS5 keyword search. |
| `ASSETS` | R2 | Asset file storage. Without it, asset metadata is stored but files can't be served via `/assets/`. |
| `AI` | Workers AI | Embedding generation for semantic search (uses `bge-small-en-v1.5`, 384 dimensions). |
| `VECTORIZE` | Vectorize | Semantic vector search. Requires `AI`. Without both, search falls back to FTS5 keyword matching. |
| `CMS_READ_KEY` | Secret | API key required for GraphQL reads. Without it, GraphQL is open. |
| `CMS_WRITE_KEY` | Secret | API key required for REST writes, MCP, and publish/unpublish. Without it, writes are open. |
| `ASSET_BASE_URL` | Variable | Public URL prefix for asset URLs and Cloudflare Image Resizing. Must be a custom domain (not `workers.dev`) for image transforms. |

Example `wrangler.jsonc` with all bindings:

```jsonc
{
  "d1_databases": [{ "binding": "DB", "database_name": "my-cms-db", "database_id": "..." }],
  "r2_buckets": [{ "binding": "ASSETS", "bucket_name": "my-cms-assets" }],
  "vectorize": [{ "binding": "VECTORIZE", "index_name": "my-cms-content" }],
  "ai": { "binding": "AI" },
  "vars": { "ASSET_BASE_URL": "https://cms.example.com" }
}
```

To create the Vectorize index: `npx wrangler vectorize create my-cms-content --dimensions=384 --metric=cosine`

### Search modes

Search is always available via FTS5 (built into D1). When `AI` + `VECTORIZE` bindings are configured, two additional modes unlock:

- **`keyword`** — FTS5 BM25 ranking. Exact word matching, phrases (`"exact match"`), prefix (`word*`), boolean (`AND`/`OR`).
- **`semantic`** — Vectorize cosine similarity. Finds conceptually related content even when query and document share no keywords.
- **`hybrid`** (default when Vectorize available) — Reciprocal rank fusion of keyword + semantic results. Records appearing in both sets get boosted.

All fields are indexed by default. Opt a field out with `{"searchable": false}` in its validators.

## Lifecycle hooks

React to content events with hooks passed to `createCMSHandler`. Hooks fire in the service layer after the operation completes — use them to trigger deploys, invalidate caches, or sync to external services.

```typescript
import { createCMSHandler } from "agent-cms";

export default {
  fetch(request: Request, env: Env) {
    return createCMSHandler({
      bindings: {
        db: env.DB,
        assets: env.ASSETS,
        environment: env.ENVIRONMENT,
        assetBaseUrl: env.ASSET_BASE_URL,
        readKey: env.CMS_READ_KEY,
        writeKey: env.CMS_WRITE_KEY,
      },
      hooks: {
        onPublish: ({ modelApiKey, recordId }) => {
          // Trigger a static site rebuild
          return fetch(env.DEPLOY_HOOK_URL, { method: "POST" });
        },
        onRecordCreate: ({ modelApiKey, recordId }) => {
          // Send a Slack notification, sync to analytics, etc.
        },
      },
    }).fetch(request);
  },
};

interface Env {
  DB: D1Database;
  ASSETS?: R2Bucket;
  ENVIRONMENT?: string;
  ASSET_BASE_URL?: string;
  CMS_READ_KEY?: string;
  CMS_WRITE_KEY?: string;
  DEPLOY_HOOK_URL: string;
}
```

Available hooks: `onRecordCreate`, `onRecordUpdate`, `onRecordDelete`, `onPublish`, `onUnpublish`. All receive `{ modelApiKey, recordId }`. Hooks are fire-and-forget — errors are logged, not propagated to the caller.

## Stack

- **Runtime**: Cloudflare Workers (edge, no cold starts)
- **Database**: D1 (managed SQLite)
- **Assets**: R2 + Cloudflare Image Resizing
- **Search**: SQLite FTS5 + Cloudflare Vectorize
- **Application**: [Effect](https://effect.website) — HTTP routing, SQL, validation, error handling, dependency injection
- **Schema engine**: `@effect/sql` with hand-written DDL for both system tables and runtime-generated content tables
- **GraphQL**: [graphql-yoga](https://the-guild.dev/graphql/yoga-server) with generated SDL
- **Testing**: [Vitest](https://vitest.dev) (`npm test`, `npm run test:run`)

## Example

See [`examples/blog/`](./examples/blog/) for a complete setup: a CMS Worker paired with an Astro site that queries the GraphQL API, renders structured text with block dispatch, and handles responsive images.

## License

MIT
