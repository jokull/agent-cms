# Idiomatic Effect Patterns

Reference for how this codebase uses Effect 3.x. "Effect all the way down."

## Architecture

```
Cloudflare Worker entry (src/index.ts)
  → Layer.orDie on D1Client.layer — fails loud if config is wrong
  → createWebHandler(sqlLayer, options)
    → Layer.merge(sqlLayer, vectorizeLayer) — single composed layer
    → Effect.provide(fullLayer) at handler boundary
    → Effect.runPromise only at framework boundaries (GraphQL Yoga, MCP SDK)
```

## Rules

### 1. No module-level mutable state

Wrong:
```typescript
let _ai: AiBinding | undefined;
export function configureAi(ai: AiBinding) { _ai = ai; }
export function embed(text: string) {
  return Effect.promise(() => _ai!.run(...)); // ! assertion = code smell
}
```

Right — use `Context.Tag`:
```typescript
export class VectorizeContext extends Context.Tag("VectorizeContext")<
  VectorizeContext,
  Option.Option<{ ai: AiBinding; vectorize: VectorizeBinding }>
>() {}

export function embed(text: string) {
  return Effect.gen(function* () {
    const bindings = yield* VectorizeContext;
    if (Option.isNone(bindings)) return;
    // ...
  });
}
```

Provide through Layer composition at the edge:
```typescript
const vectorizeLayer = Layer.succeed(
  VectorizeContext,
  env.AI && env.VECTORIZE
    ? Option.some({ ai: env.AI, vectorize: env.VECTORIZE })
    : Option.none()
);
const fullLayer = Layer.merge(sqlLayer, vectorizeLayer);
```

### 2. No `as` casts — use Schema.decodeUnknown

Wrong:
```typescript
const { modelApiKey, records } = rawBody as { modelApiKey: string; records: unknown[] };
```

Right:
```typescript
const BulkCreateInput = Schema.Struct({
  modelApiKey: Schema.NonEmptyString,
  records: Schema.Array(Schema.Record({ key: Schema.String, value: Schema.Unknown })),
});

const { modelApiKey, records } = yield* Schema.decodeUnknown(BulkCreateInput)(rawBody).pipe(
  Effect.mapError((e) => new ValidationError({ message: `Invalid input: ${e.message}` }))
);
```

### 3. No `any` — use row types or `unknown`

SQL queries should use typed row interfaces:
```typescript
// Wrong
const models = yield* sql.unsafe<Record<string, any>>("SELECT * FROM models");
models.map((m: any) => m.api_key);

// Right
import type { ModelRow } from "../db/row-types.js";
const models = yield* sql.unsafe<ModelRow>("SELECT * FROM models");
models.map((m) => m.api_key); // fully typed
```

### 4. Errors are `Data.TaggedError`

All domain errors use `Data.TaggedError` and form a discriminated union:
```typescript
export class NotFoundError extends Data.TaggedError("NotFoundError")<{
  readonly entity: string;
  readonly id: string;
}> {}

export type CmsError = NotFoundError | ValidationError | ...;
```

Yield errors directly in generators:
```typescript
if (!model) return yield* new NotFoundError({ entity: "Model", id: apiKey });
```

Use `isCmsError()` type guard (not `as` cast) at boundaries:
```typescript
if (isCmsError(error)) {
  const mapped = errorToResponse(error); // exhaustive switch on _tag
}
```

### 5. Use actual types from @effect/platform, not duck-typing

Wrong:
```typescript
if (error && typeof error === "object" && "_tag" in error &&
    (error as { _tag: string })._tag === "RouteNotFound") {
```

Right:
```typescript
import { HttpServerError } from "@effect/platform";
if (error instanceof HttpServerError.RouteNotFound) {
```

### 6. `Effect.runPromise` only at framework integration boundaries

These are the only acceptable places:
- `HttpApp.toWebHandler()` — Effect → Web Standard handler
- GraphQL resolver bridge (`runSql` in schema-builder.ts)
- MCP tool handler bridge (`run` in mcp/server.ts)

Everything between services stays in Effect. Never `runPromise` mid-pipeline.

### 7. External async APIs → `Effect.tryPromise`

Wrong:
```typescript
export async function vectorizeSearch(ai, vectorize, query) {
  const embedding = await ai.run(MODEL, { text: [query] });
  return await vectorize.query(embedding, { topK: 20 });
}
// Called as: Effect.promise(() => vectorizeSearch(ai!, vectorize!, query))
```

Right:
```typescript
export function vectorizeSearch(ai, vectorize, query) {
  return Effect.gen(function* () {
    const embeddings = yield* Effect.tryPromise({
      try: () => ai.run(MODEL, { text: [query] }),
      catch: (error) => new VectorizeError({ message: `Search failed: ${error}` }),
    });
    return yield* Effect.tryPromise({
      try: () => vectorize.query(embeddings[0], { topK: 20 }),
      catch: (error) => new VectorizeError({ message: `Query failed: ${error}` }),
    });
  });
}
```

### 8. Fire-and-forget with `Effect.ignore`

For non-critical side effects (webhooks, search indexing):
```typescript
yield* fireWebhooks("record.create", payload); // errors don't propagate
yield* vectorizeIndex(...).pipe(Effect.ignore); // swallows all errors
```

### 9. Schema validation at system boundaries

Use `Schema.decodeUnknown` for all external input:
```typescript
const body = yield* Schema.decodeUnknown(CreateRecordInput)(rawBody).pipe(
  Effect.mapError((e) => new ValidationError({ message: `Invalid input: ${e.message}` }))
);
```

Composite field types (color, lat_lon, seo) validate via registry schemas in `field-types.ts`.

### 10. Pure functions stay pure

Not everything needs Effect. These are correctly non-Effect:
- `slug.ts` — string → string
- `field-types.ts` — static registry
- `db/validators.ts` — typed accessors
- `dast/` — DAST validation and traversal
- `graphql/filter-compiler.ts` — SQL generation
- `search/extract-text.ts` — text extraction

The guideline: if it doesn't do I/O and can't fail in a way that matters, keep it pure.

## Layer Composition

```
D1Client.layer({ db })     → SqlClient.SqlClient
  .pipe(Layer.orDie)        → crash on config error (startup)

Layer.succeed(VectorizeContext, Option.some/none)

Layer.merge(sqlLayer, vectorizeLayer) → full requirement set
```

Provided once at the handler boundary. All services yield what they need:
```typescript
export function createRecord(body: unknown) {
  return Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;      // from sqlLayer
    const bindings = yield* VectorizeContext;     // from vectorizeLayer
    // ...
  });
}
```

## What Not To Do

- `let` + `configureX()` for runtime bindings → use Context.Tag
- `body as SomeType` → use Schema.decodeUnknown
- `Record<string, any>` → use typed row interfaces or `unknown`
- `try { JSON.parse() } catch {}` inside Effect.gen → acceptable for defensive deserialization of DB data, but prefer row types that avoid it
- Duck-typing platform errors → import the actual error class
- `Effect.runPromise` in service code → keep it at boundaries only

## Type Safety Sweep Prompt

Use this prompt to audit and fix type safety issues. Run periodically or before releases.

```
Sweep src/ for type safety issues. Scan for these patterns:
- `as ` casts (excluding `as const`)
- `JSON.parse` returning untyped data
- `!` non-null assertions
- `try/catch` inside Effect.gen (should use Effect error handling)

Group findings by severity:

**Critical** (production crash risk):
- JSON.parse on nullable/unknown data without guards
- Non-null assertions (!) on Map.get(), Array.find(), optional chains
- try/catch inside Effect.gen bypassing the error channel

**Moderate** (type hole, silent wrong behavior):
- `as SomeType` on external/dynamic data without runtime validation
- Repeated decode patterns that should be extracted into typed helpers

**Acceptable** (leave alone):
- `as const` assertions
- Resolver dict mutations `(resolvers.Query as Record<string, unknown>)`
- `as` after thorough typeof/shape guards
- One `as` at a generic utility boundary (e.g. JSON parse wrapper)
- `try { JSON.parse() } catch {}` for defensive DB deserialization

Fix critical issues. For moderate issues, propose fixes but don't touch
files the user is actively editing. Use Schema.decodeUnknown at system
boundaries, typed helpers for repeated patterns, and early-return guards
instead of bang assertions.
```
