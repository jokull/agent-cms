# vinext + agent-cms Draft Preview Example

Demonstrates draft preview mode with vinext (Next.js App Router on Cloudflare Workers).

## Key files

- `src/app/api/draft-mode/enable/route.ts` — validates preview token against CMS, sets `__agentcms_preview` cookie, redirects
- `src/app/api/draft-mode/disable/route.ts` — clears cookie, redirects
- `src/lib/cms.ts` — GraphQL client that forwards preview token as `X-Preview-Token`
- `src/app/posts/[slug]/page.tsx` — post page with multi-root GraphQL query (fetches post + site settings in one request), shows "Draft" badge for unpublished content
- `src/components/preview-bar.tsx` — server component that shows a fixed "Draft Preview" bar when the preview cookie is set
- `worker/index.ts` — Cloudflare Worker entry point, copies env vars to `process.env`
- `vite.config.ts` — Vite config with vinext and Cloudflare plugins

## How preview works

1. Agent creates a draft via MCP, gets `_previewPath`
2. Agent calls `get_preview_url`, gets fully assembled URL like `https://mysite.com/api/draft-mode/enable?token=pvt_...&redirect=/posts/my-draft`
3. User clicks the link
4. Enable route validates token, sets `__agentcms_preview` cookie, redirects
5. Page reads the cookie and fetches with `X-Preview-Token` header — CMS returns draft content
6. `PreviewBar` component shows "Draft Preview" with exit link

## Setup

```bash
pnpm install
CMS_URL=http://localhost:8787 pnpm dev
```

## Deploy to Cloudflare Workers

```bash
pnpm build
wrangler deploy
```

Set `CMS_URL` in `wrangler.jsonc` vars or via `wrangler secret put CMS_URL` for production.

The CMS must be running with a schema that has `canonicalPathTemplate` set on your models.
