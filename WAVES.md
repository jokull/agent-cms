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
