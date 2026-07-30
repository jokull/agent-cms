# ADR 0004: The typed RPC surface is generated result-rpc fragments, merged into the host app, running services in-process

Status: accepted (2026-07-29; grilled as wayfinder ticket 01)

## Context

agent-cms's fourth interface (after REST/GraphQL/MCP) is a codegen step emitting a typed
result-rpc contract for a project's content schema, consumed by a React admin the developer
already owns ("bring your own UI, components, auth, app, and router"). The fork: contract-only
over a generic endpoint, vs a generated router; and whether handlers proxy to a CMS over REST
or run in-process.

## Decision

The host developer owns the infrastructure (vendored CMS: their D1/R2 bindings), so the
generated server does not talk to the CMS — it *is* the CMS surface:

1. **Fragments, not a standalone app.** Codegen emits `cmsContract(app, { mutationErrors })`
   (browser-safe) and `cmsProcedures(app, contract, deps)` (server-only) — builders generic
   over the HOST's `rpc.context<C>()` factory, spread into the host's own contract and router.
   One client, one cache, one failure algebra; host middleware wraps CMS procedures directly.
2. **In-process over Effect services** via a factory taking the bindings
   (`deps: { DB } | { layer }`, plus `actor` mapper and asset config), through the `agent-cms/lib`
   library entry and one ManagedRuntime per factory call. Full error fidelity — no HTTP hop.
3. **Bindings-only.** No REST-proxy transport ships; a remote transport gets built when a real
   non-Cloudflare host exists.
4. The standalone CMS Worker remains deployed for the agent-facing interfaces (MCP/GraphQL/
   REST) against the same D1; cross-isolate schema-version invalidation covers the two-writer
   topology.

Canonical implementation pattern (learned the hard way): the generated `cmsProcedures` types
its `contract` parameter WIDE (`ReturnType<typeof cmsContract<C, ErrorDefinitionMap>>`) so
handler error-unions stay concrete; client-side type safety comes from `cmsContract`'s concrete
return. `mutationErrors` is a required option (`{}` when no auth).

## Consequences

The generated artifact stays small and reviewable (~1,000 lines for a 4-model schema, thin
procedures over a shared static runtime). BYO-auth is structural: agent-cms declares no auth
failures; the host's middleware contributes them (ADR 0005). Schema mutation stays agents-only
(MCP) — the RPC surface is content CRUD.
