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
