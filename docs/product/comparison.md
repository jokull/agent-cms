# How agent-cms compares

agent-cms is not a general-purpose headless CMS. It is a self-hosted, agent-driven content backend built on Cloudflare Workers + D1. It targets developers who want their AI coding agent to own the entire content workflow — schema design, content creation, publishing — with no browser UI involved.

This page compares agent-cms to popular headless CMS platforms across the dimensions that matter.

## At a glance

| | agent-cms | DatoCMS | Contentful | Sanity | Strapi | Payload |
|---|---|---|---|---|---|---|
| **Primary interface** | MCP (AI agents) | Web UI | Web UI | Web UI (Studio) | Web UI | Web UI |
| **Content delivery** | GraphQL | GraphQL | REST + GraphQL | GROQ + GraphQL | REST (GraphQL plugin) | REST + GraphQL |
| **Hosting** | Self-hosted (Cloudflare) | Managed SaaS | Managed SaaS | Managed SaaS | Self-hosted or Cloud | Self-hosted or Cloud |
| **Cloudflare Workers** | Native | No | No | No | No | Via OpenNext shim |
| **Database** | D1 (SQLite) | Proprietary | Proprietary | Content Lake | PostgreSQL/SQLite | PostgreSQL/SQLite/MongoDB |
| **Search** | FTS5 + semantic hybrid | Basic | Basic | Basic | Basic/plugin | Basic |
| **Pricing** | Cloudflare usage costs | Per-seat tiers | Per-seat tiers | Per-seat tiers | Free / Enterprise | Free / Enterprise |
| **Renderer compatibility** | DatoCMS renderers | Native | Own SDK | Own SDK | Own SDK | Own SDK |

## What agent-cms does well

### Agent-native workflow

There is no admin panel. Schema and content are managed entirely through MCP tools by AI agents (Claude Code, Cursor, etc.) or through the REST API. This means content operations are version-controllable, scriptable, and auditable in the same environment where you write code.

Traditional CMSs bolt on APIs as an afterthought. agent-cms was designed API-first, agent-first.

### Search that actually works

Most headless CMSs offer rudimentary full-text search or punt to external services (Algolia, Meilisearch). agent-cms has built-in dual-mode search:

- **FTS5 keyword search** — BM25 ranking, phrase matching, prefix search, boolean operators. Always available, zero config.
- **Semantic vector search** — Cloudflare Vectorize + Workers AI embeddings. Understands meaning, not just keywords.
- **Hybrid mode** — Reciprocal rank fusion combines both. Enabled automatically when Vectorize is bound.

No external search service. No sync pipelines. No additional billing.

### DatoCMS renderer compatibility

agent-cms implements DatoCMS's GraphQL schema conventions and DAST structured text format. This means existing rendering libraries — `react-datocms`, `datocms-svelte`, `vue-datocms` — work out of the box. You get `responsiveImage` with srcSet, structured text block dispatch, SEO meta tags, and all the patterns these libraries expect.

Migrating from DatoCMS? Your frontend rendering code stays the same.

### Cloudflare-native, not Cloudflare-adapted

agent-cms is built directly on Cloudflare Workers primitives — D1 for storage, R2 for assets, Vectorize for semantic search, Workers AI for embeddings. There is no application framework being shimmed onto Workers through a compatibility layer.

Payload CMS can deploy to Cloudflare Workers via OpenNext, which adapts a Next.js application (admin UI, React Server Components, the full stack) to run within Workers' constraints. It works, but it is a compatibility layer on top of a framework that was not designed for Workers — with compressed size limits, runtime constraints, and the inherent complexity of that translation.

agent-cms has none of that. It is a Worker. The entire CMS — schema engine, GraphQL API, MCP server, search indexer — runs as a single Worker with direct bindings. No cold start penalties from framework initialization, no adapter overhead.

### Self-hosted, zero vendor lock-in

Runs on your Cloudflare account. Your data lives in D1 and R2 — databases and buckets you control. Export the full schema anytime via `GET /api/schema`. No seat-based pricing, no enterprise sales calls, no surprise invoices.

### Instant schema migrations

Schema changes (add a model, add a field, change a field type) generate DDL diffs and apply transactionally. SQLite supports transactional DDL, so migrations are atomic. No migration files to manage, no downtime windows.

### Simple deployment

```bash
npm run deploy
```

One Cloudflare Worker. One D1 database. Optional R2 bucket for assets. That's the entire infrastructure.

## What agent-cms deliberately does not do

These are not missing features — they are intentional design choices.

### No editing UI

There is no web-based admin panel for human editors. Content is created and managed by AI agents through MCP, or programmatically through the REST API. If your workflow requires non-technical editors logging into a browser to write content, agent-cms is not the right tool.

### No multi-user or permissions

There are no user accounts, roles, or granular permissions. Authentication is a single read key and a single write key. If you need per-editor permissions, approval workflows, or audit trails tied to human users, use a traditional CMS.

Environment isolation is handled at the infrastructure level — fork a Cloudflare D1 database for staging, preview, or per-branch environments. This gives you more control than application-level environment management.

### No webhooks

There is no webhook system for pushing events to external services. Since agent-cms is self-hosted on your Cloudflare account, you can add event handling directly in the Worker, use Cloudflare Queues, or wire up any integration at the infrastructure level. The indirection of webhooks is unnecessary when you own the runtime.

### No plugin ecosystem

There is no marketplace of UI widgets or field editor plugins. The extension point is the MCP tool interface and the REST API — both of which AI agents and scripts can drive directly.

### No visual content builder

No drag-and-drop page builders or WYSIWYG layout editors. Content structure is defined through models and fields; rich content uses structured text (DAST) with typed blocks. The agent understands your content model and creates well-structured content without a visual canvas.

## Detailed comparison

### vs DatoCMS

DatoCMS is the closest comparison — agent-cms deliberately mirrors its GraphQL schema, structured text format (DAST), and field type vocabulary so that frontend rendering code is portable between them.

**Choose DatoCMS when** you need a polished editing UI for a content team, built-in localization workflows with translator roles, a plugin marketplace, and managed infrastructure with an SLA.

**Choose agent-cms when** you want AI agents to own content operations, you prefer self-hosted infrastructure on Cloudflare, you want hybrid search built in, and you don't need a browser-based editor.

### vs Contentful

Contentful targets large enterprises with complex content operations across multiple teams. It has deep workflow automation, granular permissions, and a large integration ecosystem — priced accordingly.

**Choose Contentful when** you have a large content organization with distinct roles, need enterprise compliance certifications, and budget is not a primary concern.

**Choose agent-cms when** you're a developer or small team, want AI-driven content workflows, and would rather pay Cloudflare usage costs than per-seat SaaS pricing.

### vs Sanity

Sanity offers maximum flexibility through code-defined schemas (GROQ query language, customizable Studio UI). It appeals to developers who want full control over the editing experience.

**Choose Sanity when** you want a highly customized editing UI, need GROQ's query flexibility, or want Sanity's Content Lake for enterprise data centralization.

**Choose agent-cms when** you don't need an editing UI at all, prefer standard GraphQL over a proprietary query language, and want simpler self-hosted infrastructure.

### vs Payload

Payload is the closest comparison in terms of deployment model — it's open-source, self-hostable, and recently added Cloudflare Workers support. But the approaches are fundamentally different. Payload is a full-stack Next.js application with a rich admin UI, and its Cloudflare deployment works through OpenNext, which adapts Next.js to run on Workers. It supports PostgreSQL, SQLite, and MongoDB.

**Choose Payload when** you need a polished admin UI for content editors, want tight Next.js integration, need multi-user permissions with role-based access, or want a large open-source community.

**Choose agent-cms when** your content workflow is agent-driven, you want a Cloudflare-native architecture without the OpenNext shim, you want built-in hybrid search, or you want DatoCMS renderer compatibility for your frontend.

### vs Strapi

Strapi is the most popular open-source headless CMS. Self-hostable, REST-first, with a conventional admin panel. It's the closest in spirit to "own your infrastructure" but built around human editors.

**Choose Strapi when** you want an open-source CMS with a traditional admin UI, need REST APIs, or want a large community ecosystem.

**Choose agent-cms when** your content workflow is agent-driven, you want native GraphQL with DatoCMS renderer compatibility, and you prefer Cloudflare's edge infrastructure over managing servers.

### vs WordPress

WordPress powers 43% of the web. It has an unmatched plugin ecosystem and is familiar to virtually every content creator.

**Choose WordPress when** you need a mature ecosystem, non-technical editors, or any of the thousands of WordPress plugins.

**Choose agent-cms when** you're building a modern headless frontend, want structured content with typed fields, and your content workflow is code-and-agent-driven rather than browser-driven.
