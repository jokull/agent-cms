# @agent-cms/codegen

Generates typed [result-rpc](https://result-rpc.com) **fragments** that merge into
the host's own result-rpc app, with handlers running agent-cms's Effect services
**in-process** against the host's D1 bindings. Settled by the wayfinder grilling
tickets 01 (artifact shape) and 07 (failure unions).

There is no REST hop and no foreign SDK: the generated server *is* the CMS
surface. The host ends up with **one client, one cache, one failure algebra**
across its own procedures and the CMS.

```bash
agent-cms-codegen --schema https://cms.example.com --out-dir src/cms
# or from a saved export:
agent-cms-codegen --schema schema.json --out-dir src/cms
```

Emits:

- `contract.ts` — browser-safe: per-model wire codecs, TS types (`Post`,
  `CreatePost`, `UpdatePost`), block payload unions, and
  `cmsContract(app, { mutationErrors })` — a fragment builder generic over the
  host's `RpcFactory<C>`.
- `procedures.ts` — server-only: `cmsProcedures(app, contract, deps)`, handlers
  that run agent-cms services in-process. Imports `agent-cms/lib`.

### Peer packages the host must install

| Package | Why |
| --- | --- |
| `result-rpc` | codecs + client/server runtime (value import) |
| `@agent-cms/dast` | DAST node types. `contract.ts` does `import type … from "@agent-cms/dast"` — **types-only, erased at build**, zero runtime deps, so the contract stays browser-safe. The same package backs the CMS and `@agent-cms/editor-react`, so an editor document is assignable to a generated write input with no adapter. |
| `agent-cms` | only `procedures.ts` needs it (server side) |

```bash
pnpm add result-rpc @agent-cms/dast
```

> **`result-rpc` is published on npm** (`result-rpc@0.5.0`). The docs at
> [result-rpc.com](https://result-rpc.com) are live. This workspace consumes it via
> `link:../../../result-rpc` so CMS and RPC changes land together; hosts outside the workspace
> install the published package.

## Wire it into your own app

The host owns the `rpc.context`. Spread the CMS fragments into the host's own
contract and router — under any key (`cms` here):

```ts
import { rpc, wire, ok, err, error } from "result-rpc";
import { cmsContract } from "./cms/contract.js";
import { cmsProcedures } from "./cms/procedures.js";

// The host's OWN auth error — BYO-auth (ticket 07): agent-cms declares none.
const Unauthorized = error({ tag: "auth/unauthorized", httpStatus: 401 });

const app = rpc.context<{ user: { id: string } | null }>();

// Declare the host's auth error on every CMS mutation so a middleware can wrap
// them (result-rpc is contract-first — an undeclared middleware error is rejected).
const cms = cmsContract(app, { mutationErrors: { Unauthorized } });

export const contract = app.contract({
  cms,
  host: { whoami: app.procedure().output(/* ... */).query() },
});

// server
const authenticated = app
  .middleware<{}>()
  .errors({ Unauthorized })
  .use(async ({ context, errors, next }) =>
    context.user ? next({ context }) : err(errors.Unauthorized()),
  );

export const router = app.router({
  cms: cmsProcedures(app, cms, {
    DB: env.DB, // or { layer } for a pre-built SqlClient layer (tests, non-D1 SQLite)
    actor: (ctx) => (ctx.user ? { type: "editor", label: ctx.user.id } : null),
    mutationMiddleware: authenticated,
  }),
  host: { whoami: app.implement(/* ... */).handler(/* ... */) },
});
```

Client-side, import **only** `contract.ts` (result-rpc client boundary). One
client covers CMS and host calls:

```ts
import { createBrowserClient, batchFetchTransport } from "result-rpc/client";
import { cmsErrors } from "@agent-cms/codegen/errors";
import { contract } from "./contract.js";

const client = createBrowserClient({ contract, transport: batchFetchTransport({ url: "/rpc" }) });

const result = await client.cms.post.update({ id, data: { title } });
if (!result.ok && cmsErrors.validationFailed.is(result.error)) {
  result.error.data.issues; // [{ field?, message }] — map onto form fields
}
```

## Failure algebra (ticket 07)

Five tags in the static `cms` namespace (`@agent-cms/codegen/errors`), folded
from agent-cms's own errors:

| Tag | data | http | folded from |
|---|---|---|---|
| `cms/record-not-found` | `{ id }` | 404 | `NotFoundError` (entity Record) |
| `cms/validation-failed` | `{ issues: [{ field?, message }] }` | 400 | `AggregateValidationError`, and plain `ValidationError` as one issue |
| `cms/duplicate` | `{ field?, message }` | 409 | `DuplicateError` |
| `cms/reference-conflict` | `{ references }` | 409 | `ReferenceConflictError` |
| `cms/schema-drift` | `{ procedure, detail }` | 409 | output decode mismatch, or a missing model at runtime |

Per-op unions: `list`→drift · `byId`→notFound|drift · `create`→validation|duplicate|drift ·
`update`→notFound|validation|duplicate|drift · `delete`→notFound|refConflict|drift ·
`publish`/`unpublish`→notFound|validation|drift. Every mutation additionally
carries the host's `mutationErrors`. No auth tags and no model-not-found are
declared by agent-cms; unknown/other tagged errors (e.g. `SchemaEngineError`)
throw and are sanitized to `server/internal`.

## Shell recipe (`boundaryShells`)

`cms/schema-drift` means "stale build — regenerate": no component recovers from
it, so a host boundary shell owns it. `cmsShellClaims` is a ready pickErrors
grouping:

```tsx
import { boundaryShells, defineShell } from "result-rpc/react";
import { cmsShellClaims } from "@agent-cms/codegen/errors";

const { DefectShell } = boundaryShells();

// A shell that reacts to drift by prompting a reload/regenerate.
export const CmsShell = defineShell({
  name: "cms",
  from: DefectShell,
  claims: cmsShellClaims, // { schemaDrift }
  onError: () => location.reload(),
  provide: () => ({}),
});
```

Mounted above the routes, `cms/schema-drift` disappears from every component's
union, leaving only the domain failures (not-found, validation, duplicate) a
form actually branches on.

## Full CRUD surface

Beyond `byId`/`create`/`update`/`delete`/`publish`/`unpublish`, each **collection**
model emits: `list({ filter?, orderBy?, page?, status? }) → { records, total }`,
`search({ q, page? })` (picker rows), `duplicate`, `publishMany`/`unpublishMany`/
`deleteMany` (per-id results, never a failure), `links` (backlinks), `validate`/
`validateUpdate` (dry-run), `syncState`, `versions.{list,get,restore}`,
`schedulePublish`/`scheduleUnpublish`/`clearSchedule`, and `reorder` (sortable/tree
models only). **Singleton** models (`singleton: true`) emit `get`/`update`/`validate`/
`syncState`/`publish`/`unpublish` instead of the collection surface. A shared
`assets.*` namespace (one, not per-model) covers `list`/`get`/`createUploadUrl`/
`create`/`importFromUrl`/`update`/`replace`/`delete`/`usages`.

**Filter typing.** `list`'s `filter` is a generated per-model TS interface
(`PostFilter`, operator sets per field type, nested `AND`/`OR`) carried as
`wire.serializable<PostFilter>()`. The server re-validates every filter in
`RecordService.queryRecords`, so codegen ships the *shape* for authoring
ergonomics rather than a hand-rolled recursive AND/OR wire codec — that
round-trips losslessly through the serializer and gains nothing from a bespoke
algebra. `orderBy` is a literal union (`"title_ASC" | …` + meta columns).

**Error algebra.** `cms/validation-failed`'s issues now carry an optional
machine-readable `code` per issue. Bulk ops declare *no* cms error tags (results
are data). Asset delete adds `cms/reference-conflict` (the force-guard 409).
Every output decoded against a codec carries `cms/schema-drift`.

**Asset R2 deps.** `createUploadUrl` (presigned S3 PUT) and `importFromUrl`
(fetch → R2 put) need storage config the host supplies via
`deps.assets = { r2Bucket, r2Credentials }`. When it is absent those two
procedures fail as `server/internal` incidents; the rest of the asset surface
(metadata CRUD, list, usages) needs neither.

**Asset URLs.** Every `AssetRecord` carries an absolute `url`, and every `media` /
`media_gallery` value read off a record is the enriched `MediaRead` shape
(`upload_id` + `url` + the asset's metadata); `SeoValue` gains `image_url`, and
`PickerRow` gains `imageUrl`. Writes are unchanged — `MediaValue` is still an id
or a descriptor, and `MediaRead` is assignable to it, so read-modify-write
compiles (the CMS strips the read-only keys before storing). Tell the CMS how to
resolve them:

```ts
cmsProcedures(app, cms, {
  DB: env.DB,
  // A bucket/CDN custom domain (`<baseUrl>/<r2_key>`) …
  assets: { baseUrl: env.ASSET_BASE_URL },
  // … or, with no base URL, the origin of a host that serves
  // /assets/:id/:filename out of R2 itself.
  // assets: { r2Bucket: env.ASSETS, originUrl: new URL(request.url).origin },
});
```

Compose transforms in the browser with the zero-dependency helper — it imports
nothing from the CMS:

```ts
import { assetUrl, assetSrcSet } from "@agent-cms/codegen/assets";

assetUrl(post.cover_image, { width: 320, fit: "cover", format: "auto" });
// → https://cdn.example.com/cdn-cgi/image/width=320,fit=cover,format=auto/uploads/…
assetSrcSet(asset, [320, 640, 960], { format: "auto" });
```

It accepts a full asset row / media value or a bare URL string, keeps relative
URLs relative, and returns the source untouched when no transform is asked for.

**Presentation hints (ADR 0006).** Every model emits a `ModelPresentation`
descriptor naming the field that titles a row and the field that illustrates it,
so a list view, a picker and a link chip can render "image + title" without the
host hard-coding field names per model:

```ts
export const POST_PRESENTATION = {
  model: "post",
  title: "title",        // field api_key, or null → use the record id
  image: "cover_image",  // field api_key, or null → no preview
} as const satisfies ModelPresentation;

export const PRESENTATION = { post: POST_PRESENTATION, … };  // keyed by api_key
```

Blocks get one too (a block card is a row). The **fallback is resolved at
generation time**, so it is deterministic and readable in the artifact:

| | order |
|---|---|
| `title` | the model's `title_field` hint → a field named `title`/`name`/`heading`/`label` → the first **required** string/text/slug field → the first string/text/slug field → `null` |
| `image` | the model's `image_preview_field` hint → the first `media` field → `null` |

A hint naming a field that no longer exists is ignored (the guess runs instead).
This is the same order `RecordService` uses server-side for picker rows, so both
halves title a record identically.

Render with the emitted helper, which returns exactly the `PickerRow` shape the
`search` procedure returns — one row component serves lists, pickers and chips:

```ts
import { presentRecord, POST_PRESENTATION, PRESENTATION } from "./cms/contract.js";

const row = presentRecord(post, POST_PRESENTATION);
// { id, title, image, imageUrl, status, updatedAt }
presentRecord(record, PRESENTATION[modelApiKey]);   // fully generic
```

`title` falls back to the record id when the model has no title field (matching
picker rows); `image` is the asset id and `imageUrl` its canonical URL — null
until the value has been read back from the CMS. Localized fields carry
locale-keyed maps: pick a locale before presenting.

## Regenerate the checked-in example after changing the emitter

```bash
pnpm generate:example && pnpm test && pnpm typecheck
```
