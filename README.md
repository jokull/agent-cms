# agent-cms

Agent-first headless CMS. Runs as a Cloudflare Worker backed by D1 and R2 in your own account. No hosted service, no admin UI. Agents define schemas, manage content, and publish — via MCP.

## What you get

- **Structured text with typed blocks** — a document tree where rich components (code blocks, media, custom types) are embedded inline. One GraphQL query returns the full tree with discriminated block unions. Map directly to React/Svelte/Vue components in a single server hop. Render with [`react-datocms`](https://github.com/datocms/react-datocms), `vue-datocms`, or `datocms-svelte` — the structured text format is [DAST](https://www.datocms.com/docs/structured-text/dast), an open standard.
- **Hybrid search** — FTS5 for keyword matching, Cloudflare Vectorize for semantic similarity, combined with reciprocal rank fusion. All on D1.
- **Draft/publish with scheduling** — records start as drafts. Publishing captures a version snapshot. Schedule publish/unpublish at future datetimes. Full version history — restore to any snapshot, and the restore itself is reversible.
- **Geospatial filtering** — `lat_lon` field type with `near(latitude, longitude, radius)` queries in GraphQL.
- **Automatic reverse references** — link model A to model B, and B gets a query field for all records in A that reference it, with full filtering, ordering, and pagination.
- **Two MCP servers** — admin MCP (`/mcp`) for schema and content, editor MCP (`/mcp/editor`) scoped to content operations only. Create editor tokens with optional expiry.
- **Multi-locale with fallback chains** — per-field opt-in. Locale A falls back to B falls back to C. The GraphQL resolver walks the chain.
- **24 field types** — string, text, boolean, integer, float, date, date_time, slug (auto-generated), media (with focal point + blurhash), media_gallery, link, links, structured_text, seo (title + description + image + twitter card), json, color (RGBA), lat_lon, video. All validated with Effect schemas.
- **Tree hierarchies and sortable collections** — parent-child nesting and explicit position ordering as first-class model properties.
- **Dynamic SQL builder** — the query engine builds SQL at runtime from the content schema. No ORM, no generated client. The content schema is decoupled from your application schema — run this on the same D1 database as your site.
- **Responsive images** — Cloudflare Image Resizing with focal points, blurhash for progressive loading, color palette extraction. R2 storage, no external service.
- **Bulk operations** — create up to 1000 records in a single call.
- **Schema portability** — export the full schema as JSON (no IDs, just api_keys), import it on a fresh instance.
- **Three interfaces** — REST API, GraphQL, and MCP, all auto-generated from the content schema.
- **Effect-TS throughout** — typed errors, dependency injection via services and layers, no try/catch. The whole CMS is a single Worker.

## Quick start

Copy the prompt from [`PROMPT.md`](./PROMPT.md) into Claude Code. It assesses your project, asks how you want to integrate (standalone Worker, service binding, or mounted in an existing Worker), and wires everything up — including D1 database, wrangler config, and MCP server connection.

## Interfaces

### `/mcp` — Admin agent interface

MCP server with tools for schema management, content operations (CRUD, bulk insert, publish/unpublish, reorder), asset management, search, and schema import/export. Requires `writeKey`.

### `/mcp/editor` — Editorial agent interface

Reduced MCP server for content-authoring agents. Accepts either an editor token or `writeKey`. Exposes schema introspection, record CRUD, drafts, publish/unpublish, version restore, assets, site settings, and search. Does not expose schema mutation, token management, or admin operations.

### `/graphql` — Content delivery

Read-only GraphQL API. Supports filtering, ordering, pagination, locale fallback, and draft previews via `X-Include-Drafts`.

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

#### Naming conventions

Model `api_key` values (snake_case) map to GraphQL names:

| api_key | GraphQL type | Single query | List query | Meta query |
|---------|-------------|-------------|------------|------------|
| `blog_post` | `BlogPost` | `blog_post` | `all_blog_posts` | `_all_blog_posts_meta` |
| `category` | `Category` | `category` | `all_categories` | `_all_categories_meta` |

Block types get a `Record` suffix: `code_block` → `CodeBlockRecord`.

Field `api_key` values stay snake_case in queries: `cover_image`, `published_at`.

#### Performance model

GraphQL nesting is not compiled into one giant SQL join. The server fetches root records, batches linked records and StructuredText work into set-oriented SQL, then assembles the nested shape in memory. See [`PERFORMANCE.md`](./PERFORMANCE.md).

#### MCP resources and prompts

Agents connecting via MCP get two resources:
- **`agent-cms://guide`** — workflow order, naming conventions, field value formats
- **`agent-cms://schema`** — current schema as JSON

Two prompts for common workflows:
- **`setup-content-model`** — design and create content models from a description
- **`generate-graphql-queries`** — generate typed GraphQL queries for a model

### `/api` — REST

JSON REST API for programmatic access. Models, fields, records, assets, locales, publish/unpublish, scheduling, bulk operations, schema import/export.

### `/api/search` — Search

FTS5 keyword search with BM25 ranking and snippets, scoped to all models or a single model. When `AI` + `VECTORIZE` bindings are configured:

- **`keyword`** — FTS5. Phrases (`"exact match"`), prefix (`word*`), boolean (`AND`/`OR`).
- **`semantic`** — Vectorize cosine similarity.
- **`hybrid`** (default) — Reciprocal rank fusion of keyword + semantic results.

## Editor tokens

Editor tokens are the credential for non-admin editing flows. Create them via `POST /api/tokens` or the `editor_tokens` MCP tool (with `action: "create"`). The raw token is shown once; the server stores a hash.

Editor tokens can access `/mcp/editor`, REST content/asset operations, and draft GraphQL previews. They cannot mutate schema, manage tokens, or run admin operations.

For editor onboarding with OAuth, the package exports `createCmsAdminClient` and `createEditorMcpProxy` to stand up an app-land MCP gateway. See [`examples/editor-mcp/`](./examples/editor-mcp/).

## Scheduling

Schedule publish/unpublish at future datetimes via REST or MCP. To execute schedules automatically, add a cron trigger:

```ts
import { createCMSHandler } from "agent-cms";

let cachedHandler: ReturnType<typeof createCMSHandler> | null = null;

function getHandler(env: Env) {
  if (!cachedHandler) {
    cachedHandler = createCMSHandler({
      bindings: { db: env.DB, assets: env.ASSETS, writeKey: env.CMS_WRITE_KEY },
    });
  }
  return cachedHandler;
}

export default {
  fetch(request: Request, env: Env) {
    return getHandler(env).fetch(request);
  },
  scheduled(_controller: ScheduledController, env: Env) {
    return getHandler(env).runScheduledTransitions();
  },
};
```

```json
{ "triggers": { "crons": ["* * * * *"] } }
```

Without a cron trigger, schedules are stored and queryable but do not execute.

## Lifecycle hooks

React to content events with hooks passed to `createCMSHandler`:

```ts
createCMSHandler({
  bindings: { db: env.DB, assets: env.ASSETS, writeKey: env.CMS_WRITE_KEY },
  hooks: {
    onPublish: ({ modelApiKey, recordId }) => fetch(env.DEPLOY_HOOK_URL, { method: "POST" }),
    onRecordCreate: ({ modelApiKey, recordId }) => { /* notify, sync, etc. */ },
  },
});
```

Available: `onRecordCreate`, `onRecordUpdate`, `onRecordDelete`, `onPublish`, `onUnpublish`. All receive `{ modelApiKey, recordId }`. Fire-and-forget.

## Bindings

Only `DB` is required. Everything else is optional and degrades gracefully.

| Binding | Type | What it enables |
|---------|------|-----------------|
| `DB` | D1 | **Required.** Content storage, schema, FTS5 search. |
| `ASSETS` | R2 | Asset file storage and serving via `/assets/`. |
| `AI` | Workers AI | Embedding generation for semantic search. |
| `VECTORIZE` | Vectorize | Semantic vector search. Requires `AI`. |
| `CMS_WRITE_KEY` | Secret | Auth for writes, MCP, and publish. Without it, writes are open. |
| `ASSET_BASE_URL` | Variable | Public URL prefix for assets and Image Resizing. Must be a custom domain for transforms. |

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

## Assets

Asset binaries live in R2. Metadata in D1. Served from `/assets/:id/:filename`.

- **MCP/editor**: `import_asset_from_url` — download, store, register in one step
- **Browser**: `PUT /api/assets/:id/file` then register metadata
- **Server**: upload to R2, then `POST /api/assets`

Focal points, blurhash, and color palette are stored per-asset. Cloudflare Image Resizing generates responsive variants at the edge.

## Stack

- **Runtime**: Cloudflare Workers
- **Database**: D1 (managed SQLite)
- **Assets**: R2 + Cloudflare Image Resizing
- **Search**: SQLite FTS5 + Cloudflare Vectorize
- **Application**: [Effect](https://effect.website)
- **GraphQL**: [graphql-yoga](https://the-guild.dev/graphql/yoga-server) with generated SDL
- **Testing**: [Vitest](https://vitest.dev) (`pnpm test`)

## Examples

- [`examples/blog/`](./examples/blog/) — CMS Worker + Astro SSR site with typed GraphQL (gql.tada), structured text rendering, responsive images, service bindings
- [`examples/editor-mcp/`](./examples/editor-mcp/) — editor onboarding: app-land OAuth gateway, scoped editor tokens, separate MCP URLs for developers and editors

## License

MIT
