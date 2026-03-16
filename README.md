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

MCP server with tools for schema management (create models, add fields, configure block types), content operations (CRUD, bulk insert, publish/unpublish, reorder), asset uploads, schema import/export, and webhooks. This is the primary interface.

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

## Stack

- **Runtime**: Cloudflare Workers (edge, no cold starts)
- **Database**: D1 (managed SQLite)
- **Assets**: R2 + Cloudflare Image Resizing
- **Search**: SQLite FTS5 + Cloudflare Vectorize
- **Application**: [Effect](https://effect.website) — HTTP routing, SQL, validation, error handling, dependency injection
- **System schema**: [Drizzle](https://orm.drizzle.team) for typed system tables
- **Dynamic schema**: `@effect/sql` for runtime-generated content tables
- **GraphQL**: [graphql-yoga](https://the-guild.dev/graphql/yoga-server) with generated SDL

## Example

See [`examples/blog/`](./examples/blog/) for a complete setup: a CMS Worker paired with an Astro site that queries the GraphQL API, renders structured text with block dispatch, and handles responsive images.

## License

MIT
