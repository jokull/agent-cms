# examples/admin — THE PROOF

A working content admin built from **only** three things:

1. the **generated result-rpc client** (`@agent-cms/codegen` output, checked in at `src/cms/`),
2. the **headless DAST editor** (`@agent-cms/editor-react`),
3. this app's own React components and hand-written CSS.

No agent-cms UI is used, because none exists — that is ADR 0006's point. Every toolbar, form
input, picker, modal, table and pixel below is host-owned.

**The companion document is [`FRICTION.md`](./FRICTION.md)** — the rough edges found while
building this are the actual deliverable.

## What it demonstrates

**Server (`worker/index.ts`)**

- `cmsContract(app, { mutationErrors: { Unauthorized } })` + `cmsProcedures(app, cms, { DB, actor,
  mutationMiddleware })` spread into the host's own contract/router (ADR 0004), running
  agent-cms's Effect services in-process against a D1 binding — no REST hop.
- The host's **own** procedures in the same router: `host.whoami` and `host.inventory.list`
  (static non-CMS data), proving "one client, one cache, one failure algebra".
- Trivial dev auth: an `x-admin-user` header maps to a hardcoded user. `mutationMiddleware`
  gates every CMS mutation with the **host's** `auth/unauthorized`; `actor` records the editor in
  `_created_by` / `_updated_by` / version rows.

**Client (`src/`)**

- **Record list** (`pages/PostListPage.tsx`) — `post.list` with a title filter, status filter,
  sortable columns, pagination + total; bulk select → `publishMany` / `deleteMany` (per-id
  results rendered as data); row `duplicate` / `delete`; and a "Seats left" column joined from
  the host's own `inventory.list` through the same client.
- **Record editor** (`pages/PostEditorPage.tsx`) — `byId`, a form over every field type in the
  model, **live validation** through the `validateUpdate` dry-run (debounced 350 ms, `issues[]`
  mapped onto fields, `issues[].code` driving the copy), the **DAST editor** with block insertion
  (hero / code / gallery) and a **record picker** for `itemLink` / `inlineItem` backed by
  `post.search`, plus a sidebar over `syncState`, `links` (backlinks), `versions.list` /
  `versions.restore`, and `schedulePublish` / `clearSchedule`.
- **Media** (`pages/MediaPage.tsx`) — `assets.list` grid with search + pagination,
  `assets.update` metadata, `assets.usages`, and `assets.delete` showing the reference-conflict
  guard and the `force: true` override.
- `cmsShellClaims` mounted as a boundary shell so `cms/schema-drift` never reaches a component.

## Running it

Everything is local; nothing is deployed and no remote Cloudflare resource is touched.

### 1. Bring up the blog CMS (the schema + content source)

```bash
cd examples/blog/cms
pnpm exec wrangler d1 migrations apply test-blog-cms-db --local
pnpm exec wrangler dev --port 8787          # leaves the CMS on :8787
curl -X POST http://127.0.0.1:8787/api/setup
cd .. && npx tsx seed.ts                     # 30 posts, 3 categories, nested blocks
```

> If `wrangler dev` asks for a `CLOUDFLARE_API_TOKEN`, it is because the blog config declares
> AI / Vectorize / worker-loader bindings that want a remote connection. Run it with a slim
> local-only config (`-c`) that keeps just the `DB` binding, plus
> `--persist-to examples/blog/cms/.wrangler/state`.

### 2. Generate the client

```bash
cd examples/admin
pnpm codegen        # → src/cms/{contract,procedures}.ts from http://127.0.0.1:8787/api/schema
```

The generated files are **checked in**. `examples/blog/schema.json` is a stale export (it
predates the `feature_card` / `feature_grid` block models the seed creates), so generate from
the live `/api/schema` of the seeded CMS.

### 3. Run the admin

```bash
pnpm build          # Vite → dist/ (the Worker's assets binding serves it)
pnpm exec wrangler dev --persist-to ../blog/cms/.wrangler/state --port 8788
open http://127.0.0.1:8788/
```

`--persist-to` points the admin Worker at the **same local D1** the blog CMS seeded.

Optionally give the Media page something to show (the blog seed creates no assets):

```bash
pnpm exec tsx seed-assets.mts
```

For faster UI iteration, `pnpm dev` runs Vite on :5173 and proxies `/rpc` to the Worker on :8788.

## Verification

```bash
pnpm typecheck      # tsc over BOTH halves — see FRICTION.md #13 for why there are two tsconfigs
pnpm build          # Vite build
pnpm worker:dry-run # wrangler deploy --dry-run (bundles; deploys nothing)
```

## Layout

```
worker/index.ts          host router: CMS fragments + host procedures + dev auth
src/contract.ts          the host's contract (browser-safe; imports cms/contract only)
src/client.ts            browser client, boundary shells, CmsShell (claims cms/schema-drift)
src/cms/                 GENERATED — do not edit
src/pages/               PostListPage · PostEditorPage · MediaPage
src/components/          ContentField (DAST) · EditorToolbar · PostBlockView · RecordPicker · Fields
src/lib/                 errors (message catalog) · presentation (hand-rolled hints) · dast-bridge
src/app.css              all of the styling, hand-written
```

## Known gaps (all documented in FRICTION.md)

- No image thumbnails anywhere — there is no asset URL on the RPC surface (#3).
- No asset upload — `createUploadUrl` needs R2 deps this Worker does not configure (#19).
- "Clear field" buttons stop sending the field; they cannot unset it (#5).
- Nested structured_text inside block payloads is displayed as a count, not edited (#12).
- The Versions panel is empty until a record is published twice (#17).
- `changedFields` always reports `content` (#18).
