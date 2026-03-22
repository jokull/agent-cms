# Blog Example

A complete blog with two Cloudflare Workers:

- **cms/** — agent-cms Worker (D1 + R2)
- **site/** — Astro SSR site with service binding to CMS, typed GraphQL via gql.tada

## Setup

### 1. Start the CMS

```bash
cd cms
pnpm install
pnpm dev
pnpm run setup -- http://127.0.0.1:8787
```

CMS is now running at `http://localhost:8787` with:
- GraphQL playground at `/graphql`
- MCP server at `/mcp`
- REST API at `/api/*`

For remote environments, deploy first and then run:

```bash
CMS_WRITE_KEY=... pnpm run setup -- https://<your-cms-url>
```

### 2. Create the Schema and Content

Connect Claude to the MCP server, then give it the [PROMPT.md](./PROMPT.md):

```json
{
  "mcpServers": {
    "blog-cms": { "url": "http://localhost:8787/mcp" }
  }
}
```

Or with Claude Code:

```bash
claude mcp add --transport http blog-cms http://127.0.0.1:8787/mcp
```

The prompt walks through 4 stages:
1. **Create schema** — models, block types, fields
2. **Create content** — assets, records, StructuredText with blocks, publish
3. **Schema evolution** — add fields to existing models (tests auto-migration)
4. **Update content** — set values on new fields, re-publish

### 3. Introspect the Schema

After the agent creates the schema, re-introspect for gql.tada types:

```bash
cd site
pnpm install
pnpm run introspect   # generates ../schema.graphql
pnpm run generate     # generates src/graphql/graphql-env.d.ts
```

### 4. Start the Site

For local development without service bindings, the site needs the CMS running on a known port. For production, service bindings handle routing.

```bash
cd site
pnpm dev
```

## Architecture

```
┌─────────────────┐     service binding     ┌─────────────────┐
│  test-blog-site │ ──────────────────────> │  test-blog-cms  │
│  (Astro SSR)    │    env.CMS.fetch()      │  (agent-cms)    │
│                 │    zero latency         │                 │
│  /              │                         │  /graphql       │
│  /posts/:slug   │                         │  /mcp           │
│  /categories/   │                         │  /api/*         │
│  :slug          │                         │                 │
└─────────────────┘                         │  D1 + R2        │
                                            └─────────────────┘
```

## Key Features Demonstrated

- **responsiveImage** — Cloudflare Image Resizing with srcSet/webpSrcSet generation
- **StructuredText** — DAST rendering with block dispatch (hero, code, image gallery)
- **gql.tada** — fully typed GraphQL queries from introspected schema
- **Service bindings** — zero-latency worker-to-worker communication
- **Auto-migration** — adding fields to models with existing data
- **Draft/publish** — content lifecycle with published snapshots
- **_seoMetaTags** — auto-generated SEO meta tags
- **Slug generation** — automatic from title/name fields
- **Media gallery** — multiple image references with responsive transforms
- **SEO composite field** — title, description, image, twitterCard
