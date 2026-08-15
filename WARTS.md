# WARTS

Upstream friction found while building `examples/blocks-editor`. Grouped by the
package we author. Each entry: what it is, why it hurts, a suggested fix.

## agent-cms (`src/`, this repo)

- **`./lib` export points at source, types at a build artifact.**
  `package.json` `exports["./lib"]` = `{ "types": "./dist/lib.d.mts", "import": "./src/lib.ts" }`.
  A consumer (like this demo's `tsx` server) imports `agent-cms/lib` and must
  transpile `src/lib.ts` (the whole Effect service layer) itself; and the
  `types` path only exists after a `tsdown` build. Suggested: ship `dist/lib.mjs`
  + `dist/lib.d.mts` and point both `types` and `import` at `dist/` (the root
  entry already does), or export a real built lib entry.

## @agent-cms/codegen

- **Generated `procedures.ts` mixes import extensions.**
  It imports `./contract.ts` (with `.ts`) but `./host-errors.js` (with `.js`).
  This forces `allowImportingTsExtensions`, and blocks running the generated
  server under plain `node --experimental-strip-types` (a `.js` specifier does
  not resolve to the `.ts` file), so hosts need `tsx`/esbuild. Suggested: emit a
  consistent extension everywhere (`.js` NodeNext-style, like `host-errors.js`).

- **README drift — `cmsContract(app, { mutationErrors })`.**
  The README shows `cmsContract(app, { mutationErrors: { Unauthorized } })`, but
  the emitted signature is `cmsContract(app)` — `mutationErrors` is read from
  `./host-errors.ts`. Suggested: fix the README to `cmsContract(app)`.

- **README drift — "result-rpc is not on npm yet."**
  `result-rpc@0.5.0` IS published (`npm view result-rpc version` → `0.5.0`).
  Suggested: update the README's "Peer packages" note.

- **Block union drops field labels + hints.**
  `schema.json` carries `label`/`hint` per field, but the generated block value
  types (`HeroSectionBlock`, …) carry only values — no field `api_key → label`
  map. A host building a block form must hand-map labels per `_type`. Suggested:
  emit a per-model field-metadata map (labels + hints) beside the presentation
  descriptors.

## @agent-cms/editor-react

- **No `extensions` escape hatch on `useDastEditor`.**
  (Fixed in this change — `UseDastEditorOptions.extensions` now appends Tiptap
  extensions after the DAST set.) Needed so a host can install a slash-command
  plugin without forking the hook. This was the gap that forced the slash plugin
  in this demo to be host-owned.

- **No first-class block-payload update path.**
  `BlockViewProps` has `remove` but no `update`; the blocks map is read through
  `blocksRef`, and mutating the host's `blocks` state does NOT re-render a
  mounted node view (Tiptap node views live in a separate React tree). A host
  block FORM must therefore keep the payload in its own `useState` inside
  `blockView` and push edits out through `blockViewProps`. Suggested: add
  `update(id, next)` to `BlockViewProps` and re-render node views when the
  envelope's blocks change.

## result-rpc

- **`better-result` is a peer dependency that `link:` consumers must hand-add.**
  pnpm does not auto-install peer deps for `link:` deps, so every in-repo
  consumer (codegen, admin, this demo) must declare `better-result` explicitly or
  `pnpm install` leaves `Result.isOk`/`isErr` unresolved. Suggested: document the
  requirement prominently, or consider a regular dep.

## Effect 4

- **`Schema.Schema<T>`/`Schema.Codec<A>` annotations widen `DecodingServices` to
  `unknown`.** `Schema<T>` extends `Top` whose `DecodingServices` is `unknown`;
  annotating a value with it poisons every `decodeUnknown*` caller's `R` channel
  (`effect(missingEffectContext unknown)`). Use `Schema.Codec<T>` (DS=never) for
  schema-typed values, and annotate recursive `Schema.suspend` callbacks
  (`(): Schema.Codec<T> => …`) so mutual recursion resolves without DS=unknown.
- **`Schema.Codec<A>` as a *parameter* annotation infers the weak supertype of
  Type | Encoded** (optional fields leak in). Keep generic params schema-typed
  (`<S extends Schema.Constraint>(schema: S, …: S["Type"])`) instead.
- **`@effect/sql-sqlite-node@4` is backed by `node:sqlite`, not better-sqlite3.**
  The v3 test trick of patching `Database.prototype.prepare` (better-sqlite3) no
  longer intercepts queries; trace `node:sqlite`'s `DatabaseSync.prototype.prepare`
  instead. `@types/better-sqlite3` dep is now vestigial.
- **`HttpRouter.toWebHandler(Layer.provide(app, svc))` does NOT satisfy
  `Request.From<"Requires", …>`-marked requirements.** Provide services inside the
  handler effects, or flatten via `Effect.flatten(HttpRouter.toHttpEffect(app))`
  and `Effect.provide` the app effect before `HttpEffect.toWebHandlerLayer`.
- **MCP `CallToolResult.structuredContent` is a Json codec.** Class instances
  (e.g. `Data.TaggedError`) thrown from tool handlers fail its validation at
  construction → surface as `-32603 Internal error`. Normalize to plain JSON
  (`JSON.parse(encodeJson(v))`) before constructing results.
- **MCP sessions live in the per-router `McpServer` service context.** Building a
  fresh `createMcpHttpHandler` per request (the v3 editor-token path) makes every
  follow-up request 404 (session not found). Cache the handler per app and
  resolve the actor per request from headers.

- **`HttpEffect.toWebHandlerLayer(effect, layer)` builds the layer ONCE and
  shares it across all requests** (implementation memoizes `Layer.buildWithScope`
  in a `handlerPromise`), while `Effect.provide(effect, layer)` builds per
  request. With `@effect/sql-sqlite-node` each connection owns a `prepareCache`
  (Effect Cache, 10-min TTL) that RETAINS failed prepares — so with the
  layer-param form, a request that fails to prepare a statement before schema
  bootstrap (e.g. the `/api/setup` pattern: write fails, setup runs, write
  again) keeps failing with the stale cached error ("no such table: models")
  even though the DB file has the tables. `Effect.provide` + `Layer.empty` is
  unaffected (fresh connection/cache per request). Keep the provide form for
  handlers that bootstrap schema at runtime.

- **`Schema.URL` is broken in 4.0.0-rc.109**: `decodeUnknownOption(Schema.URL)`
  returns `None` for every input (valid URLs included) — its filter rejects
  everything. Use `Schema.URLFromString` for URL validation (string in, URL
  instance out; decodes correctly). Do NOT use `Schema.is(Schema.URL)`.
