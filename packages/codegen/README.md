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

## Regenerate the checked-in example after changing the emitter

```bash
pnpm generate:example && pnpm test && pnpm typecheck
```
