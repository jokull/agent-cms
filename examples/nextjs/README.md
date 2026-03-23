# Next.js + agent-cms Draft Preview Example

Demonstrates draft preview mode with Next.js App Router.

## Key files

- `src/app/api/draft-mode/enable/route.ts` — validates preview token against CMS, enables Next.js `draftMode()`, sets `__agentcms_preview` cookie, redirects
- `src/app/api/draft-mode/disable/route.ts` — disables `draftMode()`, clears cookie
- `src/lib/cms.ts` — GraphQL client that forwards preview token as `X-Preview-Token` and bypasses Next.js data cache when in preview mode
- `src/app/posts/[slug]/page.tsx` — post page with multi-root GraphQL query (fetches post + site settings in one request), shows "Draft" badge for unpublished content
- `src/components/preview-bar.tsx` — server component that shows a fixed "Draft Preview" bar when `draftMode().isEnabled`

## How preview works

1. Agent creates a draft via MCP → gets `_previewPath`
2. Agent calls `get_preview_url` → gets fully assembled URL like `https://mysite.com/api/draft-mode/enable?token=pvt_...&redirect=/posts/my-draft`
3. User clicks the link
4. Enable route validates token, calls `draftMode().enable()`, sets cookie, redirects
5. Page fetches with `X-Preview-Token` header → CMS returns draft content
6. `PreviewBar` component shows "Draft Preview" with exit link

## Next.js-specific details

- `draftMode().enable()` is required — it sets Next.js's `__prerender_bypass` cookie which bypasses ISR and static generation
- The `__agentcms_preview` cookie stores the actual CMS token (separate from Next.js's bypass cookie)
- `SameSite=None; Secure` on the CMS cookie for iframe compatibility
- `cache: "no-store"` on GraphQL fetches when preview token is present — bypasses Next.js data cache
- The `PreviewBar` is a server component that reads `draftMode()` directly

## Setup

```bash
pnpm install
CMS_URL=http://localhost:8787 pnpm dev
```

The CMS must be running with a schema that has `canonicalPathTemplate` set on your models.
