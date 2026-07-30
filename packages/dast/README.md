# @agent-cms/dast

DAST (DatoCMS Abstract Syntax Tree) node types and grammar constants for
[agent-cms](https://github.com/jokull/agent-cms). **Zero runtime dependencies.**

This package exists so the DAST shapes are declared exactly once. Before it, the
same interfaces were vendored three times — in the CMS, in the block editor, and
inlined into every generated `contract.ts` — and the copies diverged (custom
marks landed in one copy only, which made the editor's output un-assignable to
the generated write input).

Consumers:

- `agent-cms` — `src/dast/types.ts` re-exports this package; the Effect Schema
  validators in `src/dast/schema.ts` build on `DEFAULT_MARKS`.
- `@agent-cms/editor-react` — `src/bridge/dast-types.ts` re-exports it.
- `@agent-cms/codegen` — the emitted `contract.ts` does
  `import type { DastDocument, ... } from "@agent-cms/dast"`. Because the import
  is types-only it is erased at build time, so the generated contract stays
  browser-safe and picks up nothing from the CMS runtime.

```ts
import type { DastDocument, BlockLevelNode, Mark } from "@agent-cms/dast";
import { DEFAULT_MARKS, isCustomMark, emptyDastDocument } from "@agent-cms/dast";
```

## Exports

| Export | Kind |
| --- | --- |
| `DefaultMark`, `CustomMark`, `Mark` | types |
| `DEFAULT_MARKS`, `CUSTOM_MARK_PREFIX` | constants |
| `isDefaultMark`, `isCustomMark`, `isMark` | pure predicates |
| `SpanNode`, `LinkNode`, `ItemLinkNode`, `InlineItemNode`, `InlineBlockNode`, `InlineNode` | inline node types |
| `ParagraphNode`, `HeadingNode`, `ListNode`, `ListItemNode`, `BlockquoteNode`, `CodeNode`, `ThematicBreakNode`, `BlockNode`, `TableNode`, `TableRowNode`, `TableCellNode`, `BlockLevelNode` | block node types |
| `RootNode`, `DastDocument`, `DastNode`, `StructuredTextValue` | document types |
| `emptyDastDocument` | helper |

The Effect Schema validators are **not** here: they depend on `effect` and stay
in the CMS (`src/dast/schema.ts`).
