# blocks-editor work ledger

## Wave 1 — scaffold + schema + codegen
- [x] package.json / tsconfig / vite / index.html
- [x] schema.json (post + 5 blocks, trimmed from blog)
- [x] editor-react `extensions` escape hatch
- [x] generate src/cms/{contract,procedures,host-errors}.ts

## Wave 2 — server
- [x] server/index.ts (SqliteClient, router, seed, static)
- [x] verify /rpc + seed boot

## Wave 3 — client + contract
- [x] src/contract.ts, src/client.ts

## Wave 4 — editor (slash + blocks)
- [x] editor/slash.ts (headless PM plugin)
- [x] editor/BlockView.tsx
- [x] editor/SlashMenu.tsx
- [x] editor/DastEditor.tsx

## Wave 5 — app + verify
- [x] App.tsx (list/edit/save), app.css
- [x] build + run + agent-browser verification
  - slash menu opens (15 commands); heading + hero-block commit delete the `/`
  - save → reload → block persists

## Wave 6 — DatoCMS-style block picker
- [x] schema.json: `author` model (name/role/avatar) + `hero_section.author` link
- [x] regenerate src/cms (Author record/filter/create, link field on block)
- [x] server seed: 3 authors + hero.author
- [x] blocks.tsx: collapsible `BlockWrapper` (caret/type/title/remove) + `BlockForm`
      with empty defaults; `presentRecord` drives the header title/thumb
- [x] RecordSelect.tsx: dropdown (`search`) + "From Library" (`list` table with
      name filter + pagination) + "Create new" (`create` → select)
- [x] DastEditor.tsx: `updateBlock` wired through `blockViewProps`
- [x] app.css: wrapper/form/picker/modal/table/pill styles
- [x] verify (agent-browser): expand/collapse; typeahead lists 3 authors;
      "From Library" table filters by name; "Create new" made Alan Turing;
      headline edit updates header title; save → reload persists author + title

## Wave 7 — Effect 4 migration (PR)

- [x] Bump `effect` + all `@effect/*` to `4.0.0-rc.109` (single version); drop
      packages merged into core (`@effect/sql`, `@effect/rpc`, `@effect/ai`,
      `@effect/cli`, `@effect/experimental`, `@effect/platform`, `@effect/typeclass`,
      `@effect/printer`, `@effect/printer-ansi`)
- [x] Import map: `effect/unstable/{sql,http,httpapi,ai,cli}`, `effect/Result`,
      `@effect/sql-d1` + `@effect/sql-sqlite-node` + `@effect/platform-node` @ rc
- [x] Core renames: `Context.Tag` → `Context.Service`, `Either` → `Result`,
      `ParseResult` → `SchemaIssue`, `catchAll*` → `catch*`, `fork` → `forkChild`,
      `validateAll` → `validate`, `tapErrorCause` → `tapCause`, `zipRight` → `andThen`
- [x] Schema v4: `Union/Literals/Tuple` array forms, `filter` → `check(makeFilter)`,
      `refine` for type guards, `optionalWith` → `optionalKey`/`withDecodingDefaultType`,
      `is*` filter renames, `isBetween({min,max})`, `message` strings not thunks
- [x] HTTP: `HttpRouter.use((router) => …)` registration layers, endpoint options
      (`params/query/payload/success`), `HttpEffect.toWebHandlerLayer` +
      per-route `Effect.catch` error mapping, actor headers threaded per request
- [x] MCP: `McpServer.layerHttp` + `McpProtocol.v2025_06_18`, `Toolkit` handler
      streams (`Stream.runLast`), `CallToolResult` Json-safe `structuredContent`
- [x] Recursive schemas: `Schema.Codec<T>` callback annotations (fixes
      DecodingServices=unknown); registry `inputSchema` typed `Schema.Codec<any>`
- [x] Verification: `tsc --noEmit` clean (root), 910/910 tests, tsdown build,
      blocks-editor vite build, codegen 61/61, dast 7/7, editor-react 28/28
- [x] Test infra: `@effect/sql` imports → `effect/unstable/sql`; fast-path SQL
      tracing switched better-sqlite3 → `node:sqlite` (v4 sql-sqlite-node backend)

## Wave 8 — Effect.fn (docs-canonical function idiom)

Harvested `ai-docs/src/01_effect/01_basics/02_effect-fn.ts`: "Avoid creating
functions that return an Effect.gen, use Effect.fn instead." Effect.fn names
the function, auto-attaches a tracing span, and takes combinators as trailing
args (no .pipe on the fn).

Converted 86 service functions across 14 `src/services/*.ts` files:
`export function X(...) { return Effect.gen(function* () { ... }); }` →
`export const X = Effect.fn("X")(function* (...) { ... });` (script-driven,
paren-balanced signature detection; return-type annotations become
`Effect.fn.Return<...>`).

Deliberately NOT converted (documented exception): functions whose piped
combinators reference the fn's own args (e.g. `Effect.annotateSpans({
modelApiKey, ... })` in createRecord/publishRecord/importAssetFromUrl/...):
the trailing-combinator position is outside the generator scope, so those
keep `Effect.gen` + `.pipe` (span attributes need the args).

Remaining gens (next sweeps): router.ts routes/helpers (~57), mcp handlers,
graphql resolvers, inner arrow gens (`const f = (x) => Effect.gen(...)`).
Also flagged from docs: DateTime module (6 Date sites), RequestResolver
(4 hand-rolled graphql loaders), Model.Class (does not fit dynamic models).

## Wave 9 — DateTime, RequestResolver, Effect.fn remainder (PLAN.md)

Three docs-driven sweeps, four commits:

1. **DateTime** (`5c19816`): ai-docs 07_datetime "use the DateTime module
   instead of Date and Date.now". rc.109 facts (probe-verified): DateTime is
   NOT a Date subclass anymore (Utc = Proto{epochMilliseconds}); formatIso ==
   toISOString byte-for-byte; make() parses date-only/full/partial ISO;
   nowUnsafe is the LazyArg form; nowAsDate/fromDateUnsafe bridge Date
   boundaries. Sites: router request timing -> performance.now (duration,
   not calendar); runScheduledTransitions Date param -> DateTime.DateTime +
   formatIso; index.ts Date boundary bridges via fromDateUnsafe; field-types/
   validators parse via DateTime.make Option; write-path toISOString ->
   formatIso(yield* DateTime.now) (Clock-testable); preview expiry via
   DateTime.add. Kept raw: JWT epoch arithmetic, host-Date serialization.
2. **RequestResolver** (`a1927df` + `1f0a0c5`): ai-docs 05_batching —
   Request.Class + RequestResolver + setDelay + withCache replaces all four
   hand-rolled promise loaders (asset, linked-record, reverse-ref,
   structured-text). rc.109 facts: make/setDelay -> value; withCache ->
   Effect<RequestResolver> (evaluate ONCE — passing the Effect form rebuilds
   the cache per request); requests dedupe/cache structurally
   (StructuralProto). Race fix: resolver caches store the build PROMISE —
   lazy value caching let concurrent first callers scatter the batch
   (12 statements instead of 3; batching test caught it). Behavior delta:
   withCache caches failures (old loaders evicted) — accepted, documented.
   GqlContext loader-machinery fields deleted.
3. **Effect.fn named helpers** (`97a435d`): router queryParam/readJsonBody/
   currentActor + mcp requestActor/addPreviewPath/addPreviewPathToList.
   Inline closures (route handlers, withDecoded tool bodies) stay — names
   live in route/tool registries.

## Wave 9.5 — src/dynamic zone (untyped-shape extraction boundary)

New `src/dynamic/` directory: the ONLY place that touches inherently-untyped
content-table shape. Models are runtime-defined/migrated, so `content_<model>`
rows are `DynamicRow = Record<string, unknown>` and value shapes are only
knowable by duck-typing — the "type sandwich" middle layer (which fields on
which models is dynamic; top and bottom layers are statically typed).

Moved into the zone:
- `dynamic/row-types.ts`: DynamicRow + the named guard set (isObjectRecord,
  stringArrayFrom, stringifyTemplateValue) — from value-utils.ts (deleted)
- `dynamic/decode.ts`: deserializeRecord + decodeSnapshot (boundary decode:
  stored JSON TEXT parsed once at the extraction edge) — from gql-utils.ts

`.oxlintrc.json` gains an `overrides` block relaxing the strict type-aware
rules (no-unsafe-*, restrict-template-expressions, no-unnecessary-*) for
`src/dynamic/**` only. Rest of the codebase stays strict. Anti-slop rules can
be added to the same override later.

Also fixed the lint backlog that had accumulated since Wave 8 (oxlint was
never run in the wave commits): loaders' `Effect.Effect<X, unknown, never>`
(default `never` omitted), schedule-service `now` param annotation, and
pre-existing mcp getToolMeta / codemode-handler `tool.name` unsafe
assignments (the `(tool: AiTool.Any)` annotation WIDENED the inferred
specific tool union to `Tool.Any`, whose name is erased to any — dropped the
annotation) + structured-text `issue.path` join (map String).

Verified: tsc 0, oxlint 0 warnings/0 errors, 910/910.

## Wave 9.6 — zone enforcement (contentTableName) + buildModelRowSchema probe

- contentTableName(modelApiKey) in src/dynamic/tables.ts: all 54 content-table
  name constructions swept through it (17 files); identifier regex = defense
  in depth (api_keys validated at model creation anyway). Sweep bug caught:
  template-literal sites need `${contentTableName(x)}` interpolation, not
  literal text — reversed and redone; standalone `` `${fn(x)}` `` templates
  collapsed (no-unnecessary-template-expression).
- buildModelRowSchema probe verdict: strict per-model Schema.Struct rejects
  realistic rows (SQLite 0/1 booleans, legacy bare-string media), drops
  system columns (Schema.Struct removes unknown keys — resolvers need
  _status/_published_snapshot/...), and optional-with-default would add
  keys. parse-only fromJsonString(Unknown) == deserializeRecord byte-for-
  byte. Future zone wave: read-shaped legacy unions + system-column
  coverage from DDL + key preservation. deserializeRecord stays the
  production boundary decode.

## Wave 9.7 — anti-slop vendored + toolchain bump

Vendored dmmulroy/anti-slop (oxlint plugin, 15 rules) via its install skill:
tools/oxlint/anti-slop/ + @oxlint/plugins@1.78.0 + oxlint@1.78.0 + jsPlugins
wiring + ignorePatterns. Zone override extended: all anti-slop rules OFF in
src/dynamic/**. Related toolchain bumped: vitest 4.1.10, tsdown 0.22.14,
oxlint-tsgolint 7.0.2001. typescript stays 5.9.3 (TS7 deliberately deferred).

Findings (the point of the exercise): 1150 anti-slop errors outside the
zone — no-runtime-typeof 354, no-unsafe-dictionary-type 277, no-unknown-
parameters 162, require-safety-comment-for-type-assertion 142, no-known-
value-widening 75, no-reflect-get 54, no-unknown-returns 39, rest <15 each.
The middle layer's duck-typing LEAKS: Record<string, unknown> + typeof +
as-casts are spread across services/graphql/dast — the zone primitives
(guards/decode/table naming) are contained, but the call sites aren't.
Open decision: migration wave vs rule calibration (allowInTypeGuards) vs
keep rules off until the wave.

## Wave 10-15 — anti-slop migration complete (all 15 rules at error, lint 0/0)

PLAN.md implementation, Waves 10-15 (each committed + pushed on effect-4):

- W10 (3e2d9b2) casts: 142 assertions guard-narrowed or SAFETY-annotated
- W11 (6341d64) row schema: buildModelRowSchema + tolerant boundary decode,
  corpus-parity test, tree-resolver wiring
- W12 (40065f9) typeof: zone guards isString/isNumber/isBoolean/isObject,
  300+ conversions, allowInTypeGuards
- W13 (d88124c) dicts: DynamicRow owner contract replaces all 234
  Record<string, unknown> sites
- W14 (4e985f4) unknowns: StoredFieldValue zone type, 201 sites
- W15 (98b3968) tail: no-reflect-get direct access, spread discipline
  (DAST round-trip caught the property-form regression), widening/
  chained/object-params resolved; no-module-mocking + 3 more enabled at 0

Zone exceptions: SAFETY/casts/guards relaxations scoped to src/dynamic/**
only; documented disables (17 total) at genuine boundaries (opaque error
channels, JSON-RPC wire payloads, index-signature-typed maps, DAST
absent-key semantics) with one-line rationales.

Wave 16 (HttpApi) assessment: 57 routes, 12 HttpRouter.use groups, inputs
already schema-validated per route, errorToResponse at 8 boundary sites.
Migration is the decision-gated capstone (PLAN Q4: in-roadmap vs separate
product decision — touches the public API surface). Not started.

## Wave 16 — HttpApi migration (REST surface, committed 2e21743..efbfeaf)

41 of 49 REST routes migrated from HttpRouter to HttpApi with declared
contracts (per-endpoint error codecs carrying the old errorToResponse
body shapes + annotated statuses, declared as arrays so each keeps its
status):

- 16.1 (2e21743) models (5 routes) — the pattern: error codecs via
  Schema.encodeTo with rc.109 getter-direction drift documented in-code
- 16.2 (5f80d08) fields (4 routes)
- 16.3 (949560f) records (26 routes) — actor from handler args, query
  schemas, 204 NoContent validates, patch-blocks recordId from URL
- 16.4 (393dc10) locales/schema/search/tokens/preview-tokens/paths/setup
  (14 routes) — token expiresIn checks moved to the handler (payload-
  decode errors render empty 400s), paths at /paths (no /api prefix)
- 16.5 (efbfeaf) assets group built and REVERTED

Assets blocker (rc.109): the assets create endpoint fails with a cryptic
"Expected JSON value" SchemaError in the response encode — the service
succeeds, the encode of the identical status(201)(Unknown) success works
for models/records, but the assets group poisons the whole CmsApi layer
(model create 500s while the group is registered). Root cause not found
after deep tracing of the response-transformation internals. Assets stay
on HttpRouter (routes + handle/readJsonBody helpers restored verbatim).
health + openapi remain on HttpRouter by design (specials outside the
API contract surface).

Verified at each commit: tsc 0, oxlint 0/0, 916/916, tsdown green.

## Wave 16.6 — assets group migrated; REST migration COMPLETE (5d3bdfb)

The assets blocker from 16.5 root-caused by bisection: the assets
endpoints encoded fine with simple handlers; the REAL service returns
carried undefined-valued keys (title/alt/width/height when omitted) and
the wrapped response transformation rejects values with ANY
undefined-valued key (the raw Unknown codec passes them). Fixed by
coalescing the create out to null + moving the offset/limit query
validation to the handler (NaN limit previously 500'd the SQL).

All 49 REST routes now run on HttpApi with declared contracts. Remaining
on HttpRouter by design: /health + /openapi.json (specials).
