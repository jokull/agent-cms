# Effect 4 Migration — Resources & Reference

> Effect **4.0.0-rc.109** tagged. Stable targeted Q3/Q4 2026.
> **Status: migration implemented on `main` (PR `effect-4`)** — `effect` + all
> `@effect/*` at `4.0.0-rc.109`, 910/910 tests green, `tsc --noEmit` clean.
> The RC announcement describes interfaces as "presumed final" — no more broad breaking changes planned.

## Decisions (this repo)

- **Migrate to Effect 4 RC** (single version across the whole `@effect/*` tree).
- **Adopt TypeScript 7** — the native Go-based compiler (`tsgo`, shipped as `@effect/tsgo`), which Effect 4 is built against.
- **`gql.tada` risk**: used **only in `examples/`** (`examples/blog/site`, `examples/i18n/site`, `examples/nextjs`) — **not** in the core `src/` library. `gql.tada` does heavy TypeScript type-level inference over introspected schemas; verify it works under `tsgo` before moving those examples to TS 7. Fallback: keep the gql.tada examples on TS 5.x, or swap to a codegen approach.

## Target versions

| Package | Current | Target |
|---|---|---|
| `effect` | `^3.21.0` | `4.0.0-rc.109` ✅ |
| all `@effect/*` | independent 0.x | matching `4.0.0-rc.x` ✅ |
| `typescript` | `^5.9.3` | `7` (native / `@effect/tsgo`) — **follow-up, not in this PR** |
| `@effect/language-service` | `^0.81.0` | `^0.87.2` ✅ |

In v4 every Effect ecosystem package shares one version number: `effect@4.0.0-rc.108` pairs with `@effect/sql-d1@4.0.0-rc.108`, etc.

## Primary resources — start here

1. **Official migration guide (entry point)**
   https://github.com/Effect-TS/effect/blob/main/MIGRATION.md
   Covers versioning, package consolidation, the unstable-module system, and links every sub-guide below.

2. **RC announcement** — "We think this is it…"
   https://www.effect.website/blog/releases/effect/40-rc
   Migration-readiness context, `effect@rc` install, Discord/Office Hours channels.

3. **Beta announcement** — "A Consolidated Core"
   https://www.effect.website/blog/releases/effect/40-beta
   Background on the structural changes (consolidation, versioning).

## Official migration sub-guides

All under `Effect-TS/effect` → [`migration/`](https://github.com/Effect-TS/effect/tree/main/migration):

| Guide | What it covers | Relevance |
|---|---|---|
| [`v3-to-v4.md`](https://github.com/Effect-TS/effect/blob/main/migration/v3-to-v4.md) | Generated import/API **rename map** (4433 lines) | **High** — the mechanical import-path + rename map |
| [`schema.md`](https://github.com/Effect-TS/effect/blob/main/migration/schema.md) | **Schema v4** migration | **Critical** — agent-cms uses Schema everywhere |
| [`services.md`](https://github.com/Effect-TS/effect/blob/main/migration/services.md) | `Context.Tag` → `Context.Service` | **Critical** — all DI (`SqlClient`, `VectorizeContext`, …) |
| [`error-handling.md`](https://github.com/Effect-TS/effect/blob/main/migration/error-handling.md) | `catch*` renames | **High** — `errors.ts` uses `Data.TaggedError` |
| [`runtime.md`](https://github.com/Effect-TS/effect/blob/main/migration/runtime.md) | `Runtime<R>` removed, `run*` at the edge | **High** — `Effect.runPromise` boundaries |
| [`cause.md`](https://github.com/Effect-TS/effect/blob/main/migration/cause.md) | Flattened `Cause` structure | Medium |
| [`forking.md`](https://github.com/Effect-TS/effect/blob/main/migration/forking.md) | `fork` → `forkChild`/`forkDetach`, fork options | Medium |
| [`fiber-keep-alive.md`](https://github.com/Effect-TS/effect/blob/main/migration/fiber-keep-alive.md) | Automatic fiber lifetime management | Medium |
| [`layer-memoization.md`](https://github.com/Effect-TS/effect/blob/main/migration/layer-memoization.md) | Layer memoization across `Effect.provide`, `Layer.fresh` | Medium |
| [`fiberref.md`](https://github.com/Effect-TS/effect/blob/main/migration/fiberref.md) | `FiberRef` → `Context.Reference` | Low |
| [`scope.md`](https://github.com/Effect-TS/effect/blob/main/migration/scope.md) | Scope / resource lifecycle | Low |
| [`equality.md`](https://github.com/Effect-TS/effect/blob/main/migration/equality.md) | Structural equality by default | Medium — affects `Data`/`Equal` usage |
| [`yieldable.md`](https://github.com/Effect-TS/effect/blob/main/migration/yieldable.md) | Effect subtyping → Yieldable protocol | Medium — `Effect.gen` |

## Community skill (agent-readable, bundles the official guides)

**`effect-v4`** skill (`teeverc/effect-ts`, mirrored via `NeverSight/skills_feed`) — aggregates the official migration guides into agent-ready `references/` files plus v4 core patterns:

- SKILL.md: https://raw.githubusercontent.com/NeverSight/skills_feed/refs/heads/main/data/skills-md/teeverc/effect-ts/effect-v4/SKILL.md
- Migration overview + ordered checklist: `references/migration.md`
- Per-topic references: `references/migration/{runtime,error-handling,cause,services,fiberref,forking,fiber-keep-alive,scope,layer-memoization,generators,yieldable,equality}.md`
- v4 core patterns: `references/{core-usage,dependency-management,schema,error-management,concurrency,…}.md`

## Tooling / codemods

- **Codemod** (Effect v3→v4): https://app.codemod.com/registry/effect-v3-to-v4
- **`@effect/language-service`** — agent-cms already runs `"prepare": "effect-language-service patch"`; verify v4 behavior (the patch targets the TS compiler Effect relies on; likely replaced/augmented by `@effect/tsgo`).
- **`@effect/tsgo`** — Effect's distribution of the native TypeScript compiler for TS 7.
- **`@effect/vitest`** — v4 testing utilities (`effect` testing moved to `effect/testing/*`).

## Key breaking changes (orientation)

1. **Single versioning** — all `@effect/*` released together at `4.0.0-rc.x`.
2. **Package consolidation** — `@effect/platform`, `@effect/rpc`, `@effect/cluster`, `@effect/cli`, `@effect/ai`, `@effect/experimental`, `@effect/sql`, `@effect/opentelemetry`, `@effect/typeclass`, `@effect/workflow` moved into `effect` core or `effect/unstable/*`.
3. **Unstable module system** — `effect/unstable/{ai,cli,cluster,devtools,eventlog,http,httpapi,jsonschema,observability,persistence,process,reactivity,rpc,schema,socket,sql,workflow,workers}`; may break in minor releases until graduated to `effect/*`.
4. **Core renames** — `Context.Tag` → `Context.Service`; `Either` → `Result`; `FiberRef` → `References`/`Context.Reference`; `TMap`/`TRef`/`TQueue`/… → `TxHashMap`/`TxRef`/`TxQueue`/…; `ParseResult` → `SchemaIssue`/`SchemaParser`; `Runtime<R>` removed; `catch*` renamings.
5. **Schema v4** — large surface change (see below).

## Where our `@effect/*` packages moved

| Current package | v4 location |
|---|---|
| `@effect/sql` (`SqlClient`, `Migrator`, `Statement`, `SqlError`, `SqlSchema`, `SqlResolver`, `SqlStream`, `SqlConnection`, `Model`) | `effect/unstable/sql/*` (`SqlModel` also `effect/unstable/schema/Model`) |
| `@effect/sql-d1` | `@effect/sql-d1` @ matching `4.0.0-rc.x` |
| `@effect/rpc` (`Rpc`, `RpcClient`, `RpcServer`, `RpcSchema`, …) | `effect/unstable/rpc/*` |
| `@effect/ai` (`Chat`, `Tool`, `Prompt`, `Model`, `Tokenizer`, `McpServer`, …) | `effect/unstable/ai/*` |
| `@effect/cli` (`Command`, `Args`, `Options`, `Prompt`, …) | `effect/unstable/cli/*` (renamed: `Args`→`Argument`, `Options`→`Flag`, …) |
| `@effect/experimental` (`DevTools`, `Sse`, `EventLog`, `Persistence`, `Reactivity`, `VariantSchema`, …) | `effect/unstable/{devtools,encoding,eventlog,persistence,reactivity,schema}/*` |
| `@effect/platform` (`FileSystem`, `Path`, `Terminal`, `Error`) | `effect/*` (`FileSystem`, `Path`, `Terminal`, `PlatformError`) |
| `@effect/platform` (HTTP, HttpApi, Socket, Cookies, …) | `effect/unstable/{http,httpapi,socket}/*` |
| `@effect/platform` (`Worker`, `Transferable`, `KeyValueStore`) | `effect/unstable/{workers,persistence}/*` |
| `@effect/typeclass` (`Semigroup`, `Monoid`) | `effect/*` (`Combiner`, `Reducer`) |
| `@effect/platform-node` | **verify** — likely `@effect/platform-node` @ v4 or folded into `effect` |

## Schema v4 highlights (agent-cms uses Schema heavily)

- `asSchema` → `revealCodec`; `encodedSchema` → `toEncoded`; `typeSchema` → `toType`.
- `Literal("a","b")` → `Literals(["a","b"])`; `Union(A,B)` → `Union([A,B])`; `Tuple(A,B)` → `Tuple([A,B])`; `TemplateLiteral(A,B)` → `TemplateLiteral([A,B])`.
- `filter` → `check`/`refine`; all filter names `is`-prefixed (`int`→`isInt`, `minLength`→`isMinLength`, …); `positive`/`negative`/`nonNegative`/`nonPositive` **removed**.
- `*FromSelf` suffix dropped (`DateFromSelf`→`Date`, `BigIntFromSelf`→`BigInt`, …); `Schema.Date` now `DateFromSelf` — **use `DateFromString` for the old ISO-string behavior**.
- `decode` → `decodeEffect`; `decodeUnknownEither` → `decodeUnknownExit`; `validate*` **removed**; `Data(schema)` **removed**.
- `Schema.Redacted(v)` → `RedactedFromValue(v)`; `Schema.Redacted` is now the old `RedactedFromSelf`.
- `annotations` → `annotate`; `pattern` → `check(isPattern(...))`; `pick`/`omit`/`partial`/`extend` → `mapFields(Struct.*)`.
- Full guide: [`migration/schema.md`](https://github.com/Effect-TS/effect/blob/main/migration/schema.md).

## Related context

- **effect-cf** (Effect-native Cloudflare bindings, already on Effect 4) — useful as a reference for CF bindings under v4. See GitHub issue #69.
- **`@cloudflare/vitest-pool-workers`** — independent of Effect version; candidate for closing the Worker-boundary test gap.

## Open questions — verify during migration

- [x] `@effect/printer` / `@effect/printer-ansi` — **removed in v4** (no replacement); both were unused in this repo, deps dropped.
- [x] `@effect/platform-node` — still a package at `4.0.0-rc.109` (`NodeRuntime` retained).
- [x] `@effect/sql-sqlite-node` — `4.0.0-rc.109`, now backed by **`node:sqlite`** (not better-sqlite3).
- [x] `@effect/language-service` — stays `0.x` (no v4 line); `^0.87.2` + `effect-language-service patch` work with Effect 4.
- [ ] `gql.tada` ↔ `tsgo` (TS 7) compatibility — **follow-up**: the gql.tada examples (`examples/blog/site`, `examples/i18n/site`, `examples/nextjs`) are not in the workspace and were untouched by this PR; TS 7 itself is deferred.
