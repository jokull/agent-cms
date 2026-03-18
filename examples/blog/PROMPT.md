# Blog Example — Agent Lifecycle Prompt

You are setting up a blog using agent-cms. Connect to the CMS MCP server. Execute each stage in order. Confirm success at each checkpoint before moving on.

## Prerequisites (developer setup before running this prompt)

Before connecting the agent, the developer needs to set up infrastructure:

### 1. Deploy the CMS Worker

```bash
cd cms
pnpm install
npx wrangler deploy       # deploy to Cloudflare
CMS_WRITE_KEY=... pnpm run setup -- https://<your-cms-url>
```

### 2. Custom Domain (required for image resizing)

The CMS worker needs a custom domain on a Cloudflare zone you control. `workers.dev` subdomains do not support Image Resizing.

1. Add a custom domain to the worker: **Cloudflare Dashboard → Workers & Pages → test-blog-cms → Settings → Domains & Routes → Add → Custom Domain** (e.g. `cms.yourdomain.com`)
2. Enable Image Resizing on the zone: **Dashboard → yourdomain.com → Speed → Optimization → Image Optimization → Image Resizing → Enable**
3. Update `ASSET_BASE_URL` in `cms/wrangler.jsonc` to the custom domain URL (e.g. `https://cms.yourdomain.com`)
4. Redeploy: `npx wrangler deploy`

### 3. Connect the Agent

Add the MCP server to Claude Desktop or Claude Code:

```json
{
  "mcpServers": {
    "blog-cms": { "url": "https://cms.yourdomain.com/mcp" }
  }
}
```

For local development (no image resizing):
```json
{
  "mcpServers": {
    "blog-cms": { "url": "http://localhost:8787/mcp" }
  }
}
```

---

## Stage 1: Create Schema

### 1.1 Create Models

Create these content models using `create_model`:

| Name | api_key | singleton | Notes |
|---|---|---|---|
| Site Settings | site_settings | true | Global site configuration |
| Author | author | true | Blog author profile |
| Category | category | false | Post categories |
| Post | post | false | Blog posts |

### 1.2 Create Block Types

Create these block types using `create_model` with `isBlock: true`:

| Name | api_key |
|---|---|
| Hero Section | hero_section |
| Code Block | code_block |
| Image Gallery | image_gallery |

### 1.3 Add Fields

Add fields to each model using `create_field`. Use the model's `id` from step 1.1/1.2.

**site_settings:**

| label | api_key | fieldType | validators | notes |
|---|---|---|---|---|
| Site Name | site_name | string | `{"required": true}` | |
| Tagline | tagline | text | | |
| Logo | logo | media | | |
| Default SEO | default_seo | seo | | |

**author:**

| label | api_key | fieldType | validators |
|---|---|---|---|
| Name | name | string | `{"required": true}` |
| Bio | bio | text | |
| Photo | photo | media | |

**category:**

| label | api_key | fieldType | validators |
|---|---|---|---|
| Name | name | string | `{"required": true}` |
| Slug | slug | slug | `{"slug_source": "name"}` |
| Description | description | text | |
| Cover Image | cover_image | media | |

**post:**

| label | api_key | fieldType | validators |
|---|---|---|---|
| Title | title | string | `{"required": true}` |
| Slug | slug | slug | `{"slug_source": "title"}` |
| Excerpt | excerpt | text | |
| Cover Image | cover_image | media | |
| Content | content | structured_text | `{"structured_text_blocks": ["hero_section", "code_block", "image_gallery"]}` |
| Author | author | link | `{"item_item_type": ["author"]}` |
| Category | category | link | `{"item_item_type": ["category"]}` |
| Related Posts | related_posts | links | `{"items_item_type": ["post"]}` |
| Published Date | published_date | date | |
| SEO | seo_field | seo | |
| Gallery | gallery | media_gallery | |

**hero_section:**

| label | api_key | fieldType | validators |
|---|---|---|---|
| Headline | headline | string | `{"required": true}` |
| Subheadline | subheadline | text | |
| Background Image | background_image | media | |
| CTA Text | cta_text | string | |
| CTA URL | cta_url | string | |

**code_block:**

| label | api_key | fieldType | validators |
|---|---|---|---|
| Code | code | text | `{"required": true}` |
| Language | language | string | |
| Filename | filename | string | |

**image_gallery:**

| label | api_key | fieldType | validators |
|---|---|---|---|
| Images | images | media_gallery | |
| Caption | caption | text | |
| Layout | layout | string | |

### 1.4 Checkpoint

Call `schema_info` and verify:
- 4 content models (site_settings, author, category, post)
- 3 block types (hero_section, code_block, image_gallery)
- All fields present on each model

---

## Stage 2: Create Sample Content

### 2.1 Upload Assets

Before creating content, upload sample images to R2 and register them.

Use the `upload_asset` MCP tool to register these assets (the agent should guide the user through `wrangler r2 object put` for the actual file upload, or use placeholder r2Keys):

1. **Site logo** — `r2Key: "uploads/logo.svg"`, filename: "logo.svg", mimeType: "image/svg+xml"
2. **Author photo** — `r2Key: "uploads/author.jpg"`, filename: "author.jpg", mimeType: "image/jpeg", width: 400, height: 400
3. **Post cover 1** — `r2Key: "uploads/cover-agents.jpg"`, filename: "cover-agents.jpg", mimeType: "image/jpeg", width: 1200, height: 630
4. **Post cover 2** — `r2Key: "uploads/cover-workers.jpg"`, filename: "cover-workers.jpg", mimeType: "image/jpeg", width: 1200, height: 630
5. **Post cover 3** — `r2Key: "uploads/cover-graphql.jpg"`, filename: "cover-graphql.jpg", mimeType: "image/jpeg", width: 1200, height: 630
6. **Hero background** — `r2Key: "uploads/hero-bg.jpg"`, filename: "hero-bg.jpg", mimeType: "image/jpeg", width: 1920, height: 1080
7. **Gallery image 1** — `r2Key: "uploads/gallery-1.jpg"`, filename: "gallery-1.jpg", mimeType: "image/jpeg", width: 800, height: 600
8. **Gallery image 2** — `r2Key: "uploads/gallery-2.jpg"`, filename: "gallery-2.jpg", mimeType: "image/jpeg", width: 800, height: 600

### 2.2 Site Settings

Create the singleton record:
```json
{
  "site_name": "Agent CMS Blog",
  "tagline": "A blog built entirely by AI agents",
  "logo": "<logo asset id>",
  "default_seo": {
    "title": "Agent CMS Blog",
    "description": "Exploring the future of content management with AI agents"
  }
}
```

### 2.3 Author

Create the singleton:
```json
{
  "name": "Demo Author",
  "bio": "Building the future of content management. This blog is managed entirely through AI agents — no admin UI needed.",
  "photo": "<author photo asset id>"
}
```

### 2.4 Categories

Create 3 categories:

1. **Technology** — `name: "Technology"` (slug auto-generates to "technology")
2. **Tutorial** — `name: "Tutorial"` (slug auto-generates to "tutorial")
3. **Opinion** — `name: "Opinion"` (slug auto-generates to "opinion")

### 2.5 Posts

Create 3 blog posts. For each, use `build_structured_text` to construct the content field.

**Post 1: "The Agent-First CMS"**
- category: Technology
- excerpt: "What happens when you replace the admin dashboard with an AI agent? We built agent-cms to find out."
- cover_image: cover-agents asset
- published_date: "2025-01-15"
- content: StructuredText with:
  - A `hero_section` block (headline: "The Future is Agent-First", subheadline: "No dashboard. No forms. Just conversation.", background_image: hero-bg asset)
  - A paragraph of body text about the project
  - A `code_block` block (language: "typescript", filename: "src/index.ts", code showing the createCMSHandler setup)
- author: link to author record
- seo_field: `{ title: "The Agent-First CMS | Agent CMS Blog", description: "What happens when you replace the admin dashboard with an AI agent?" }`

**Post 2: "Why Cloudflare Workers"**
- category: Technology
- excerpt: "D1, R2, service bindings — the full Cloudflare stack makes the CMS possible."
- cover_image: cover-workers asset
- published_date: "2025-02-01"
- content: StructuredText with:
  - Paragraphs about Cloudflare's edge platform
  - A `code_block` showing a wrangler.toml configuration
- author: link to author record

**Post 3: "GraphQL for Content Delivery"**
- category: Tutorial
- excerpt: "How to query your CMS content with typed GraphQL using gql.tada."
- cover_image: cover-graphql asset
- published_date: "2025-03-01"
- content: StructuredText with:
  - Paragraphs about GraphQL and type safety
  - A `code_block` showing a gql.tada query
  - An `image_gallery` block (images: gallery-1 + gallery-2 assets, caption: "Schema introspection in action", layout: "grid")
- author: link to author record
- gallery: [gallery-1, gallery-2] (media_gallery field)
- related_posts: [post 1 id] (tests links field)

### 2.6 Publish All

Publish every record: site_settings, author, all categories, all posts.

### 2.7 Checkpoint

Query via `query_records` for each model. Verify:
- 1 site_settings, 1 author, 3 categories, 3 posts
- All records have `_status: "published"`
- Post slugs are auto-generated ("the-agent-first-cms", "why-cloudflare-workers", "graphql-for-content-delivery")
- Post 3 has `related_posts` linking to Post 1

---

## Stage 3: Schema Evolution

This stage tests auto-migration. We add fields to models that already have published data. Existing records must survive with null values for the new fields — zero data loss.

### 3.1 Add Fields to Post

Use `create_field` to add:

| label | api_key | fieldType |
|---|---|---|
| Reading Time | reading_time | integer |
| Featured | featured | boolean |

### 3.2 Add Fields to Category

Use `create_field` to add:

| label | api_key | fieldType |
|---|---|---|
| Icon | icon | string |
| Sort Order | sort_order | integer |

### 3.3 Checkpoint

1. Call `schema_info` — confirm 4 new fields appear on their respective models
2. Call `query_records` for `post` — existing posts must still be returned, with `reading_time: null` and `featured: null`
3. Call `query_records` for `category` — existing categories must still be returned, with `icon: null` and `sort_order: null`

This confirms the schema engine correctly ran `ALTER TABLE ADD COLUMN` without touching existing data.

---

## Stage 4: Update Content with New Fields

### 4.1 Update Posts

Use `update_record` to set the new fields:

- Post 1 ("The Agent-First CMS"): `reading_time: 5`, `featured: true`
- Post 2 ("Why Cloudflare Workers"): `reading_time: 8`, `featured: true`
- Post 3 ("GraphQL for Content Delivery"): `reading_time: 6`, `featured: false`

### 4.2 Update Categories

- Technology: `icon: "cpu"`, `sort_order: 1`
- Tutorial: `icon: "book-open"`, `sort_order: 2`
- Opinion: `icon: "message-circle"`, `sort_order: 3`

### 4.3 Re-publish Updated Records

Publish all updated records to push changes to the published snapshot.

### 4.4 Final Checkpoint

1. Query posts — all should have non-null `reading_time` and `featured` values
2. Query categories — all should have `icon` and `sort_order` values
3. Verify draft/publish: edit Post 1's title without re-publishing. The public API should still show the original title, but `query_records` with draft mode should show the edit.

---

## Summary

After completing all 4 stages, the CMS has:
- **7 models** (4 content + 3 block types)
- **29+ fields** across all models
- **8 assets** registered
- **8 content records** (1 site_settings + 1 author + 3 categories + 3 posts)
- **Auto-migrated** 4 fields onto existing populated tables
- **Draft/publish** lifecycle exercised
- **StructuredText** with 3 block types embedded in content
- **Slug auto-generation** from title/name fields
- **Link and links** fields with cross-model references
- **Media and media_gallery** fields with asset references
- **SEO** composite fields
- **responsiveImage** queryable on all media fields via GraphQL

The frontend (Astro site in `../site/`) can now query all of this via the GraphQL API at `/graphql`, with full `responsiveImage` transforms via Cloudflare Image Resizing.

### Fulltext Search

All content records are automatically indexed in FTS5 on create/update/delete. The site includes a `/search` page that queries `POST /api/search`. The MCP server exposes a `search_content` tool for agent-driven search.

**Alternative setup:** Use `npx tsx seed.ts` from the `examples/blog/` directory to seed schema + content + FTS5 index in one step (requires the CMS running on localhost:8787).

The seed script creates 6 posts with content specifically designed to demonstrate the **vocabulary mismatch problem** — where keyword search fails but vector search (Phase 2) would succeed:

| Semantic query | Would match | Why FTS5 misses it |
|---|---|---|
| "how to make websites faster" | Computation at the Periphery | Uses "latency", "distance", not "faster" |
| "dealing with too much information" | The Curation Deficit | Discusses "attention", "scarcity", not "information" |
| "catching bugs before production" | Contracts All the Way Down | Uses "runtime failure", "contracts", not "bugs" |
| "letting AI handle publishing" | Delegation and Trust | Discusses "governance", "autonomy", not "handle" |
