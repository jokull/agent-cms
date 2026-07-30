# FRICTION — building a real admin on the generated client + editor toolkit

This is the primary deliverable of the "proof" exercise (wayfinder ticket 10). Everything below
was hit while building `examples/admin`, a working content admin over the seeded blog CMS. Each
entry is **what I tried → what happened → what the API should have done → which ticket/ADR it
bears on**.

Verified facts (real runs, not guesses) are marked **[measured]**.

Severity: **S1** blocked the app · **S2** forced a hack or a cast · **S3** cost time / bad DX ·
**S4** noted.

---

## #0 — RESOLVED (stale build artifact, not an API flaw) — Worker boot crash from `result-rpc`

**Tried.** The exact pattern from `packages/codegen/README.md` and ADR 0004: build the contract
and router at module scope, hand the router to `createFetchHandler`, export `{ fetch }`.

**Happened.** `wrangler dev` refuses to boot the isolate: **[measured]**

```
service core:user:test-admin-proof: Uncaught Error: Disallowed operation called within
global scope. Asynchronous I/O (ex: fetch() or connect()), setting a timeout, and
generating random values are not allowed within global scope.
```

Bisected to one line — `result-rpc/dist/server/contract.js`:

```js
const neverAborted = new AbortController().signal;   // module scope
```

Constructing an `AbortController` at module scope is a disallowed global-scope operation in
workerd. Importing **anything** from `result-rpc` (even just `rpc`) is enough; the failing
module is pulled in transitively.

`wrangler deploy --dry-run` bundles it happily — it never evaluates the module — so the bug is
invisible to a build-only CI check. Only an actual isolate start (or a deploy) surfaces it.

**RESOLUTION (verified after this report was written).** The diagnosis above is accurate about
the symptom but wrong about the cause, and the conclusion ("the documented pattern is not
runnable") is **false**. `result-rpc`'s *source* had already been fixed to construct the signal
lazily — `src/server/contract.ts:53-57`, with a comment naming this exact Workers constraint —
but the `link:`ed `dist/` was built a day earlier and still had the module-scope form. Rebuilding
result-rpc (`pnpm build` in that repo) removes the crash.

Re-verified here: the worker was converted **back to static module-scope imports** exactly as
`packages/codegen/README.md` documents, and `wrangler dev` boots and serves `/rpc` normally.
The dynamic-`import()` workaround described below is no longer present in `worker/index.ts`.

The real, still-valid lessons: (1) a `link:`ed pre-1.0 dependency can silently serve a stale
`dist` — the admin's package should depend on a built artifact, and result-rpc needs a
prepublish/prepare build; (2) `wrangler deploy --dry-run` genuinely does not evaluate modules,
so build-only CI cannot catch a global-scope violation — an actual isolate start belongs in CI.

**Should have.** `neverAborted` should be lazily created (`const neverAborted = () =>
new AbortController().signal`, or a module-level `let` filled on first use). Cloudflare Workers
is the *stated* target host for this whole stack (ADR 0004: "the host developer owns the
infrastructure — their D1/R2 bindings"), so this is the primary deployment target failing on
import.

**Workaround in this app.** `worker/index.ts` does every `import` of `result-rpc`,
`result-rpc/server`, `src/contract.ts` and `src/cms/procedures.ts` **inside the `fetch`
handler** via dynamic `import()`, caching the built handler in a module-level promise. It works,
but it means the documented wiring snippet is wrong for the only host that currently exists, and
the host pays a first-request cost for building the contract + router.

**Bears on.** ADR 0004 (the wiring pattern shipped in the README is not runnable as written on
Workers) and `result-rpc` itself (one-line fix, in a sibling repo — deliberately not modified).

---

## #1 — S2 — DAST is vendored three times and the copies are not assignable

**Tried.** Feed `useDastEditor`'s `onChange` document straight into the generated
`StructuredTextWrite` for `post.update`.

**Happened.** Compile error. `@agent-cms/editor-react` vendors DAST types where a span's marks
are `DefaultMark | \`customMark_${string}\``; the generated `contract.ts` vendors a *third*
copy (agent-cms `src/dast/types.ts` is the first) where marks are the six defaults only:

```
Type 'BlockLevelNode' is not assignable to type 'DastBlockLevelNode'.
  Type 'Mark' is not assignable to '"code" | "strong" | ... | "highlight"'.
    Type '`customMark_${string}`' is not assignable to ...
```

The editor package's own file says so out loud: *"PROTOTYPE NOTE: vendored copy… Keep
byte-identical to the source of truth until that is decided."* They are **not** byte-identical
today: the mark union diverged when custom marks landed.

**Should have.** One DAST type module, imported by both. Either the editor package imports the
generated types, or both import a `@agent-cms/dast-types` package. As shipped, the two halves of
the product do not typecheck against each other — which is the single most expensive thing in
this app.

**Workaround.** `src/lib/dast-bridge.ts`: a 70-line adapter that strips `customMark_*` and
re-narrows through a user-defined type predicate (`doc is EditorDast & ContractDast`). It avoids
`as`, but it is a runtime walk of every node on every keystroke, and it silently drops custom
marks — data loss that only doesn't bite here because this field declares none.

**Bears on.** Ticket 15 (editor seam / packaging), ticket 13 (editing primitives).

---

## #2 — RESOLVED — codegen emits no presentation hints, so a record list cannot render generically

**Tried.** ADR 0006: *"Models carry presentation hints (`title_field`, `image_preview_field`) …
so record lists, pickers, and link chips can render 'image + title' rows generically. Codegen
computes deterministic fallbacks at generation time."* I looked for them in `contract.ts`.

**Happened.** They are nowhere in the generated artifact. `grep -i title_field|image_preview`
over the 950-line `contract.ts` returns nothing. The hints exist only *server-side*, inside the
`search` procedure, which returns `PickerRow { id, title, image, status, updatedAt }`. `list`
returns full typed records with no indication of which field is the title.

**Should have.** Emit `export const POST_PRESENTATION = { titleField: "title", imageField:
"cover_image" } as const;` per model. It costs three lines of codegen and it is the difference
between "a host list view renders generically" and "every host hand-writes it per model".

**Workaround.** `src/lib/presentation.ts`, hard-coded per model.

**RESOLUTION (BUILDOUT 4 / G3).** Codegen emits `<MODEL>_PRESENTATION`
(`{ model, title, image }` field api_keys, `satisfies ModelPresentation`) for every model plus a
`PRESENTATION` registry keyed by api_key, with the fallback resolved at generation time (hint →
title/name/heading/label → first required string → first string → null; image hint → first media
field → null) and a `presentRecord(record, presentation)` helper returning the same `PickerRow`
shape `search` returns. `PostListPage` renders its rows through it; the hand-rolled
`postTitle`/per-model map is gone.

**Bears on.** ADR 0006, ticket 06 (entity models).

---

## #3 — RESOLVED — there is no asset URL anywhere on the RPC surface

**Tried.** Render a thumbnail in the record list, the media grid, the picker rows, and the block
cards.

**Happened.** Impossible. `AssetRecord` exposes `r2_key`, `blurhash`, `colors`, `focal_point` —
but no URL and no base URL. `PickerRow.image` is typed `string | null` and carries an **asset
id**, not a URL. The CMS Worker knows `ASSET_BASE_URL` (it's a `var` in
`examples/blog/cms/wrangler.jsonc`), the RPC host does not, and `cmsProcedures` deps have no
place to put it.

Consequence: an admin built on this surface **cannot show images**. Every "Preview" cell,
every media tile, and every block card in this app renders an id string in a dashed box. This is
the most visible way the app fails to look like a real CMS.

**Should have.** Either `deps.assets.baseUrl` fed into every asset-shaped output as a `url`
field, or a documented `assetUrl(asset)` helper exported from the codegen runtime. Cloudflare
Image Resizing (the project's stated image story) needs a real origin URL to transform.

**RESOLUTION (BUILDOUT 4 / G1).** Canonical URLs now exist on the read surface, and the admin
renders real images in the media grid, the list's preview column, the picker rows, the cover-image
field and the DAST image block cards.

- Every asset row carries `url`. Resolution order: configured `ASSET_BASE_URL` → `<base>/<r2_key>`
  (identical to what GraphQL already emitted); else the caller's origin →
  `<origin>/assets/<id>/<filename>`, the route the CMS Worker serves from R2; else that same path,
  relative. Never null.
- `media` and every `media_gallery` entry are read back as the reference merged with the asset
  (`{ upload_id, url, filename, mime_type, size, width, height, alt, title, focal_point,
  custom_data, blurhash }`); `seo` keeps `image` (the id) and gains `image_url`. Writes are
  unchanged — an id or a descriptor — and the read-only keys are stripped again on write, so
  read-modify-write is lossless. One batched `WHERE id IN (…)` per record set, block payloads
  included.
- `PickerRow` gained `imageUrl` alongside `image`.
- Transforms: `assetUrl(asset, { width, height, fit, format, quality })` (plus `assetSrcSet`) from
  `@agent-cms/codegen/assets`, composing Cloudflare Image Resizing `/cdn-cgi/image/...` URLs.
- The host tells the CMS which of the two it is via `deps.assets.baseUrl` / `deps.assets.originUrl`.

**Bears on.** ADR 0006 (presentation hints are pointless without a URL), ticket 04 (field types).

---

## #4 — S3 — generated `procedures.ts` uses `.ts` import specifiers

**Tried.** `tsc --noEmit` over the generated output with a normal bundler tsconfig.

**Happened.** **[measured]**

```
src/cms/procedures.ts(40,8): error TS5097: An import path can only end with a '.ts' extension
when 'allowImportingTsExtensions' is enabled.
```

`procedures.ts` imports `"./contract.ts"`; `@agent-cms/codegen/server-runtime` imports
`"./errors.ts"`. Generated code should not force a compiler flag on its consumer.

**Should have.** Emit `"./contract.js"` (bundler/NodeNext-safe) like every other emitter does.

**Bears on.** ADR 0004 (artifact shape).

---

## #5 — S2 — a field cannot be cleared

**Tried.** "Clear" buttons on the link/media/date/number fields.

**Happened.** The generated update input is `{ author?: string }` — there is no `null` anywhere
in the write vocabulary. Setting `undefined` is not even expressible under
`exactOptionalPropertyTypes` (see #13), and omitting the key means "don't touch it", not "clear
it". So the admin's Clear button is a lie: it stops *sending* the field, it does not unset it.

**Should have.** `author?: string | null` in the create/update inputs, with `null` meaning
"clear". DatoCMS does exactly this. Right now "remove this record's author" is not expressible
through the typed surface at all.

**Bears on.** ADR 0004 (input shape), ticket 04.

---

## #6 — S3 — `orderBy` is a flat string-literal union

**Tried.** Sortable table headers: state is `(column, direction)`, the API wants
`"_updatedAt_DESC"`.

**Happened.** Template-literal reconstruction (`` `${column}_${dir}` ``) is a plain `string`, not
assignable to `PostOrderBy`. Every host writes the same `candidates.find(...)` dance this app
has in `PostListPage.tsx`.

**Should have.** Also emit `export const POST_ORDER_FIELDS = [...] as const` (or accept
`{ field, direction }`), so `(column, direction)` state maps to the wire type without a lookup.

**Bears on.** ADR 0006 (list views are supposed to be self-sufficient).

---

## #7 — RESOLVED — block insertion is order-sensitive BYO state, and the ordering is subtle

**Tried.** `insertBlock` from a toolbar button: create an id, put the payload in React state,
call `handle.commands.insertBlock(id)`.

**Happened.** The node view renders from `blocksRef.current`, which `useDastEditor` assigns
**during render** from `value.blocks`. `setBlocks(...)` has not re-rendered yet when
`insertBlock` runs synchronously, so the card paints "unresolved block payload" for a frame.

**Workaround.** Keep a *second* mutable ref (`liveBlocks`), assign the new map into it, then
`setBlocks`, then `insertBlock`, then re-emit — the ordering is load-bearing and nothing in the
API says so.

**Should have.** `handle.commands.insertBlock(payload)` taking the payload and owning the map
(the toolkit already owns the map for reads), or at minimum
`handle.setBlocks(next)` so the ref update is explicit and synchronous.

**RESOLUTION (BUILDOUT 4 / G3).** `commands.insertBlock(draft)` takes the payload: the toolkit
mints the id (or reuses `draft.id`), registers the payload in the map node views read *before*
inserting the atom, then calls the new `onBlockCreate(id, draft)`. The host's `setState` can land
whenever React gets to it — the ordering bug is impossible by construction, and the second
`liveBlocks` ref is gone from `ContentField`. Proven by
`packages/editor-react/test/hook.test.tsx` ("renders the payload on the first frame…"), which
asserts no render ever saw an unresolved payload.

**Bears on.** Ticket 13, PLAN.md's own "block insertion is order-sensitive BYO-state".

---

## #8 — S2 — the read envelope's block payloads are not assignable to the write shape

**Tried.** `content: { value, blocks: envelope.blocks }` on `post.update`.

**Happened.** `PostContentEnvelope["blocks"]` is `Record<string, HeroSectionBlock | …>`;
`StructuredTextWrite["blocks"]` is `Record<string, Record<string, unknown>>`. A TypeScript
interface has no index signature, so it is **not** assignable to `Record<string, unknown>`. With
`as` banned, the only way out is to rebuild every payload:

```ts
Object.fromEntries(Object.entries(blocks).map(([id, b]) => [id, Object.fromEntries(Object.entries(b))]))
```

**This is the finding**: reading a record and writing it straight back does not typecheck.

**Should have.** `StructuredTextWrite` should be generic per field —
`{ value: DastDocument; blocks?: Record<string, PostContentBlockWrite> }` where the write block
union is the read union minus server-owned keys. Codegen already knows the union; it emits it
for the read side one screen earlier in the same file.

**Bears on.** ADR 0004, ticket 13.

---

## #9 — RESOLVED — `blockView` cannot receive a single host prop

**Tried.** An "edit" button on each block card that opens the host's payload editor.

**Happened.** `blockView` is typed `ComponentType<BlockViewProps<Block>>` and `BlockViewProps`
is closed: `{ id, block, inline, remove }`. There is no `extraProps`, no render-prop form, and
the component identity is a `useMemo` dependency, so closing over host state re-creates the
editor. Everything a card needs beyond those four values — an edit callback, the asset base URL,
the current locale, a drag handle — must travel through React context.

**Workaround.** `src/components/block-editing.ts`: a context just to smuggle one callback in.

**Should have.** `blockView: (props: BlockViewProps<Block>) => ReactNode` invoked as a function
(no identity/memo hazard), or a `blockViewProps` passthrough.

**RESOLUTION (BUILDOUT 4 / G3).** `useDastEditor({ blockView, blockViewProps })`:
`BlockViewProps<Block, Props>` gained `props`, delivered through a ref so a fresh object every
render neither rebuilds the extensions nor remounts a node view (tested). `PostBlockView` takes
`props.edit` directly and `src/components/block-editing.ts` — the context that existed only to
smuggle one callback — is deleted.

**Bears on.** Ticket 13/15 — this is the "one irreducible component" ADR 0006 promises, and it
is the one place the host cannot inject anything.

---

## #10 — S3 — `onChange` returns a document, not the envelope; orphan pruning is the host's job

**Tried.** Wire `onChange` to the field's value.

**Happened.** `onChange(value: DastDocument)` — no blocks. PLAN.md's own target DX says it
should fire "with the FULL envelope (value + blocks)". Worse, when the user deletes a block node
(the `×` in the card, or Backspace), the payload stays in the host's `blocks` map forever. There
is no `onBlockRemoved`, and `remove` on `BlockViewProps` only deletes the *node*. So the host has
to walk the DAST tree on every change collecting `block`/`inlineBlock` item ids and prune —
`referencedBlockIds()` in `ContentField.tsx`, ~15 lines that every consumer will rewrite.

**Should have.** `onChange(envelope)` with pruning done by the toolkit (it is the only party that
knows both halves), or export `collectBlockIds(doc)`.

**Bears on.** Ticket 13, PLAN.md.

---

## #11 — S3 — `useDastEditor`'s `value` is not reactive

**Tried.** Render the editor while `post.byId` is still loading and let the value arrive.

**Happened.** `value` is only read for the initial `content`; later changes are ignored (only
`extensions` is in the `useEditor` dep array). `handle.setValue()` exists but calling it from an
effect fights the user's cursor.

**Workaround.** Don't mount the form until the record resolves, and `key={record.id}` the whole
form so navigation between records remounts.

**Should have.** Document the non-reactivity loudly, or accept a `version`/`revision` prop that
triggers a `setContent` with cursor preservation.

**Bears on.** Ticket 13.

---

## #12 — S3 — nested structured_text inside a block payload degrades to `Record<string, unknown>`

**Tried.** Render `feature_grid`'s `features` (a `blocks_only` structured_text field on a block
model, containing `feature_card`s, which themselves contain a `code_block`).

**Happened.** Codegen emits: **[measured]**

```ts
export interface FeatureCardBlock {
  id: string; _type: "feature_card"; title: string; description?: string;
  details?: { value: DastDocument; blocks: Record<string, unknown> };  // ← untyped
}
```

The "type sandwich" holds for one level and collapses at the second. This app can only show
`Object.keys(block.features.blocks).length` for nested content — it cannot render or edit it.
There is also no story for mounting a nested `useDastEditor` inside a block card.

**Should have.** Recurse the envelope generation (the block union is already computed) and give
the toolkit a nested-editor story, or state explicitly that nested structured_text is read-only
for hosts.

**Bears on.** Ticket 13, ticket 04, the type-sandwich note in project memory.

---

## #13 — S2 — the two halves of the product require mutually exclusive tsconfigs

**Tried.** One `tsconfig.json` for the SPA and the Worker.

**Happened.** **[measured]**

* With `exactOptionalPropertyTypes: false`, `@agent-cms/editor-react`'s own source fails:
  `packages/editor-react/src/bridge/extensions.ts(345,5)` — `{ tag?: string | undefined }` is
  not a `ParseRule`. (The package's own tsconfig sets the flag `true`, so it never sees this.)
* With `exactOptionalPropertyTypes: true`, the **generated** `procedures.ts` and
  `@agent-cms/codegen/src/server-runtime.ts` fail in five places — they build
  `{ query: string | undefined, … }` objects for exact-optional targets.

So the editor toolkit requires the flag on and the generated server requires it off.

**Workaround.** Two tsconfigs (`tsconfig.json` for `src`, `tsconfig.worker.json` for
`worker` + `src/cms`), and `pnpm typecheck` runs both. Note the practical consequence: **a plain
`tsc --noEmit` in this package only checks half the app.**

**Should have.** Both packages should compile under both settings — they are library code.

**Bears on.** ADR 0004, ticket 15.

---

## #14 — S2 — `result-rpc` as a `link:` dependency ships two Reacts

**Tried.** `pnpm build && wrangler dev`, open the app.

**Happened.** **[measured]** White screen, one console exception:
`TypeError: Cannot read properties of null (reading 'useState')` — the classic two-React
dispatcher error. `result-rpc` is `link:../../../result-rpc` (a sibling checkout with its own
`node_modules/react`, same version 19.2.8, different physical copy), and Vite bundles both.

**Fix.** `resolve: { dedupe: ["react", "react-dom"] }` in `vite.config.ts`.

**Should have.** Not really agent-cms's bug — but it *will* hit every consumer while `result-rpc`
is unpublished and linked, so the codegen README's quickstart should mention it.

**Bears on.** ADR 0004 (consumer onboarding).

---

## #15 — S1-ish — `update`'s output lies about structured_text, and no codec catches it

**Tried.** Refresh the form from the mutation result instead of re-fetching.

**Happened.** **[measured]** `post.byId(...)` returns
`content = { value: {...}, blocks: {...} }` (the declared `PostContentEnvelope`).
`post.update(...)` returns `content = { schema: "dast", document: {...} }` — the **raw DAST
document**, no `blocks` key. `Object.keys(result.value.content.blocks)` throws.

The output codec is `wire.serializable<PostContentEnvelope>()`, which performs **no runtime
validation**, so `cms/schema-drift` — the tag whose entire purpose is "the output didn't match
the codec" — does not fire. The type is simply wrong and nothing notices.

**Should have.** `update`/`create`/`publish` must project structured_text exactly like `byId`.
Separately: `wire.serializable<T>()` on outputs means the drift guarantee in ADR 0005 ("every
output decoded against a codec carries `cms/schema-drift`") does not actually hold for the most
complex field type in the system.

**Workaround.** Never read `content` off a mutation result; re-fetch.

**Bears on.** ADR 0005 (failure algebra / drift claim), ADR 0004.

---

## #16 — S3 — picker `search` is FTS word-prefix, so typing mid-word finds nothing

**Tried.** The author picker, typing `a` to find "Jokull Solberg".

**Happened.** **[measured]** `author.search({ q: "" })` → 1 row. `author.search({ q: "a" })` → 0
rows. `search({ q: "Nova" })` → 0. Only word-prefix matches hit. Users type substrings; every
picker built on this will feel broken.

**Should have.** Pickers should fall back to a `LIKE %q%` on the title field (or the presentation
title) when FTS returns nothing — Dato's picker does substring matching.

**Bears on.** ADR 0006 (picker `search` is listed as sufficient for admin pickers).

---

## #17 — S3 — `versions.list` is empty for the entire normal editing lifecycle

**Tried.** A "Versions" sidebar panel.

**Happened.** **[measured]** 0 versions after create, after several `update`s, and after the
first `publish`. A version row only appears on the **second** publish (a previous
`_published_snapshot` must exist). After publish → update → publish:
`['2:publish:ada', '1:publish:ada']`.

So `update` is not versioned at all: an editor who saves a draft twenty times and never
publishes has no history and no undo. The actor mapper does work — `actor_label` is the real
user id, which is exactly what ADR 0005 promises.

**Should have.** Either version on write, or document "versions = published snapshots" so hosts
don't build a "History" panel expecting save history.

**Bears on.** ADR 0006 (versions listed as an admin primitive), ADR 0005 (audit).

---

## #18 — RESOLVED — `syncState.changedFields` is unusable as shipped

**Tried.** A "changed fields" sidebar line and a dirty indicator.

**Happened.** **[measured]** `changedFields` is `["content"]` **always** — on a freshly
published record with no edits, immediately after a publish, and after a no-op save. Confirms
the known structured_text limitation, but the practical consequence is stronger than "noisy": a
record with any structured_text field is *permanently* dirty, so the field cannot drive a
"you have unsaved changes" or "differs from published" affordance at all.

**Should have.** Compare normalized DAST (or hash the envelope) rather than the serialized
column. Until then `changedFields` should omit structured_text fields rather than always
including them — a wrong answer is worse than no answer.

**RESOLUTION (BUILDOUT 4 / G3).** `RecordService.getSyncState` now compares like-for-like: the
published snapshot stores *materialized* structured_text / rich_text, so the live row is run
through the same `materializeRecordStructuredTextFields` publish uses before the canonical-JSON
diff (skipped entirely for models with no such field). A freshly published record reports
`changedFields: []`; editing the title reports exactly `["title"]`; editing a block payload
reports the structured_text field. The admin shows a real dirty badge in the editor head.

**Bears on.** ADR 0006, ticket 13.

---

## #19 — S3 — assets cannot be uploaded, and the failure is untyped

**Tried.** An upload button via `assets.createUploadUrl`.

**Happened.** **[measured]** `server/internal` — the codegen README documents this ("when
`deps.assets` is absent those two procedures fail as `server/internal` incidents"), but it means
a host with no R2 credentials gets an *incident* (a sanitized crash, logged as a defect) for a
perfectly foreseeable configuration state. There is no typed "storage not configured" failure to
branch on, and nothing at the type level says these two procedures need extra deps.

Consequence for this proof: the Media page can list, edit metadata, show usages, and delete —
but **not upload**. `examples/admin/seed-assets.mts` creates metadata-only asset rows via
`assets.create` so the page has content.

**Should have.** A declared `cms/storage-unconfigured` tag, or omit `createUploadUrl`/
`importFromUrl` from the generated contract when `deps.assets` is absent (it's a codegen-time
decision the host could pass as a flag).

**Bears on.** ADR 0005 (failure algebra — an expected configuration failure is being treated as
a defect), ADR 0004.

---

## #20 — RESOLVED — `can()` is non-reactive and absent from the snapshot

**Tried.** Disable the block-insert buttons when insertion is impossible (the DX shown in
PLAN.md: `disabled={!s.can.insertBlock}`).

**Happened.** `useDastEditorState`'s snapshot has `canUndo`/`canRedo` and nothing else;
`handle.can()` is a point-in-time call that does not re-render toolbars. PLAN.md's own example
is not implementable. This app's block buttons are always enabled, which is honest-but-wrong.

**Should have.** Fold `DastCan` into the reactive snapshot.

**RESOLUTION (BUILDOUT 4 / G3).** `useDastEditorState`'s snapshot carries a `can` cluster —
`undo`, `redo`, `insertBlock`, `tableActions`, and `toggleMark[mark]` for every default and
declared custom mark — built from the same `buildCan` the imperative `handle.can()` uses
(`canUndo`/`canRedo` remain as deprecated aliases). `EditorToolbar` disables the mark buttons,
the three block-insert buttons and the table actions from it; PLAN.md's
`disabled={!s.can.insertBlock}` example is now literally what this app does.

**Bears on.** Ticket 13, PLAN.md.

---

## #21 — S4 — `Locale` degrades to `string` when a project has no locales

The blog CMS has `locales: []`, so codegen emits `export type Locale = string`. Harmless here
(nothing is localized) but it means `Localized<T>` silently loses all safety in exactly the
projects that later add a locale. Emitting `never` (or omitting the localization types) would
fail loudly instead.

**Bears on.** ADR 0004.

---

## #22 — S3 — `list` has no field selection, so every row carries its full DAST document

`post.list` returns the whole `PostCodec`, including `content` — the complete structured_text
envelope with all block payloads — for every row. A 10-row admin table pulls ten full documents.
GraphQL exists for shaped reads, but ADR 0006 says the RPC surface is "self-sufficient for admin
list views", and a list view does not want the body of every post.

**Should have.** A `fields?: readonly (keyof Post)[]` on `list`, or a `listSummary` projection
built from the presentation hints.

**Bears on.** ADR 0006.

---

## #23 — S4 — what actually went well (recorded so the good parts aren't lost)

* **[measured]** The fragment merge is genuinely one client: `client.cms.post.list` and
  `client.host.inventory.list` sit in one contract, one cache, one `ResultRpcProvider`. Wiring it
  took about fifteen minutes and the README snippet was accurate (modulo #0).
* **[measured]** BYO-auth works exactly as ADR 0005 describes. An anonymous mutation returns the
  host's `auth/unauthorized`; the actor mapper writes the real editor id into version rows
  (`actor_label: "ada"`).
* **[measured]** `validate`/`validateUpdate` is fast enough to drive a form: **5–9 ms** in-process
  over a local D1, **56–66 ms** end-to-end from the browser including transport, at a 350 ms
  debounce. Live validation felt instant. `issues[].field` maps onto form fields cleanly and
  `issues[].code` (`required`, `unique`, …) is genuinely enough to write host copy against —
  this is the strongest part of the whole surface.
* **[measured]** Aggregated issues, bulk ops as data (`[{id, ok, error?}]`), the asset
  reference-conflict guard (`cms/reference-conflict` with
  `references: ["post.cover_image (1m1c8gam4i)"]`, then `force: true` succeeds), `usages`,
  backlinks, scheduling, and `duplicate` all behaved exactly as documented.
* The DAST codec round-trips: a seeded document with three block types (including a nested
  `feature_grid`) loaded, rendered as host cards, took a new inserted block, and saved back with
  every original block id intact. **[measured]**
* `cmsShellClaims` + `defineShell` removed `cms/schema-drift` from every component union with
  four lines of code.

---

## Summary — top 10 by severity

| # | Severity | One line |
|---|---|---|
| 0 | ~~S1~~ resolved | Worker boot crash traced to a **stale linked `dist`**; source was already fixed. Static-import pattern verified working. |
| 15 | ~~S1~~ **fixed** | `update`/`create` now materialize the envelope at the CMS service layer (REST + MCP benefit too). The unvalidated-`serializable` drift gap remains — see below. |
| 1 | ~~S2~~ **fixed** | `@agent-cms/dast` — one types package; CMS, editor bridge and the generated prelude all import it. The proof's 70-line adapter is deleted. |
| 13 | S2 **open** | Still two tsconfigs in one app. A packaging decision — belongs to the ticket 15 grilling, not a bug fix. |
| 8 | ~~S2~~ **fixed** | Write shapes are generic over the block union; a read envelope drops straight into an update input. |
| 3 | ~~S2~~ **fixed** | Canonical `url` on assets + enriched media/gallery/seo/picker reads, one batched query; `assetUrl()` composes CF Image Resizing. The admin renders real images. |
| 5 | ~~S2~~ **fixed** | Update inputs accept `null` per field (and per locale); `clear()` is now `{ [key]: null }`. |
| 9 | ~~S2~~ **fixed** | `blockViewProps` pass-through (ref-read, no remounts). The admin's context smuggle is deleted. |
| 18 | ~~S2~~ **fixed** | The live row is materialized before diffing, so untouched structured_text is no longer permanently dirty. The admin shows a real dirty badge. |
| 7 | ~~S2~~ **fixed** | `insertBlock(draft)` mints the id and registers the payload before inserting the atom; `onBlockCreate` hands the host the id. The ordering bug is unreachable. |
