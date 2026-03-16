# DatoCMS StructuredText TypeScript Patterns

Research from `datocms/structured-text` monorepo for inspiration on our type system.

## Key Design Patterns

### 1. No Recursive Generics for the Tree

Each node type explicitly lists allowed children as a union. Recursion is structural (List → ListItem → Paragraph | List), not a self-referencing generic type.

### 2. Two Generic Params for Embeds

`BlockItemType` and `InlineBlockItemType` thread through the tree, defaulting to `string` (block ID). This lets the same types work for both raw DAST (string IDs) and resolved trees (full record objects).

### 3. Three-Generic Top-Level Value

```typescript
type CdaStructuredTextValue<
  BlockRecord extends CdaStructuredTextRecord,
  LinkRecord extends CdaStructuredTextRecord,
  InlineBlockRecord extends CdaStructuredTextRecord
> = {
  value: Document;
  blocks?: BlockRecord[];
  inlineBlocks?: InlineBlockRecord[];  // SEPARATE from blocks!
  links?: LinkRecord[];
};
```

### 4. CdaStructuredTextRecord Constraint

```typescript
type CdaStructuredTextRecord = {
  __typename: string;  // e.g., "HeroSectionRecord"
  id: string;
} & { [prop: string]: unknown };
```

**Critical for us:** Every block/link record in the GraphQL response MUST have `__typename`. Our current implementation is missing this.

### 5. Render Pipeline

Framework-agnostic via `Adapter<H, T, F>` pattern:
- `renderNode: H` — create elements (JSX, HTML string, etc.)
- `renderText: T` — render text content
- `renderFragment: F` — wrap children

Custom rules via `renderRule(guard, transform)` — pairs a type guard with a transform function.

## Action Items for Our Codebase

1. **Add `__typename` to block records in GraphQL response** — format: `{ModelApiKey}Record` in PascalCase (e.g., `HeroSectionRecord`)
2. **Separate `inlineBlocks` from `blocks`** in StructuredText GraphQL type — DatoCMS has three arrays, not two
3. **Consider adopting their generic pattern** for our DAST types — parameterize block/link item types
