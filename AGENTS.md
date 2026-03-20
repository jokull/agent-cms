# AGENTS.md — agent-cms

For agents working *on* this codebase (not consuming the CMS).

## Project structure

- `src/mcp/` — MCP server: tools, resources, prompts
- `src/graphql/` — GraphQL schema builder and resolvers (read-only content delivery)
- `src/services/` — business logic (model, field, record, publish, asset, webhook, schema-io)
- `src/db/` — row types, validator accessors
- `src/field-types.ts` — field type registry with validation schemas
- `src/dast/` — DAST (structured text) validation and traversal
- `src/search/` — FTS5 + Vectorize search
- `src/schema-engine/` — DDL generation for content tables
- `src/http/` — REST API routes
- `src/index.ts` — Cloudflare Worker entry point, layer composition

## Architecture

Effect services with `SqlClient` dependency injection. Layers composed at the entry point:
- `D1Client.layer` → `SqlClient.SqlClient`
- `VectorizeContext` → optional AI/Vectorize bindings
- `Layer.merge(sqlLayer, vectorizeLayer)` → provided once at handler boundary
- `Effect.runPromise` only at framework boundaries (MCP, GraphQL Yoga, HTTP handler)

See [`docs/contributing/effect.md`](/Users/jokull/Code/agent-cms/docs/contributing/effect.md) for full patterns.

## Conventions

- No `as` casts — use Effect Schema or runtime checks
- No `any` — use row types from `src/db/row-types.ts` or `unknown`
- Errors are `Data.TaggedError` in `src/errors.ts`
- Field api_keys are snake_case; GraphQL maps to camelCase/PascalCase at the resolver layer

## Testing

```bash
npx vitest run           # all tests
npx vitest run test/mcp  # scoped to MCP tests
```

Test helpers in `test/app-helpers.ts` — creates in-memory D1, runs migrations, provides `run()` for Effect.

## How to add things

**New field type**: Add to `src/field-types.ts` registry (column type, default, validation schema). Update `src/graphql/schema-builder.ts` for GraphQL type mapping.

**New MCP tool**: Add `server.tool(name, description, zodSchema, async (args) => run(Service.method(args)))` in `src/mcp/server.ts`. Keep tools thin — logic goes in services.

**New GraphQL feature**: Modify `src/graphql/schema-builder.ts` for SDL generation, add resolver in the appropriate `*-resolvers.ts` file. Resolvers bridge to Effect via `runSql()`.

## Effect Best Practices

**IMPORTANT:** Always consult effect-solutions before writing Effect code.

The [effect-solutions](https://github.com/kitlangton/effect-solutions) repo is cloned locally at `~/Forks/effect-solutions/`. Search it directly for patterns and examples:

```bash
# Browse available guides
ls ~/Forks/effect-solutions/

# Search for specific patterns
grep -r "Schema.Class" ~/Forks/effect-solutions/
grep -r "Layer.provide" ~/Forks/effect-solutions/
```

Never guess at Effect patterns — read the local effect-solutions guides first.
