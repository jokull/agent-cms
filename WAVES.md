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
