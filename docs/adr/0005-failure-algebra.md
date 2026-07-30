# ADR 0005: The RPC failure algebra — five cms/* tags, aggregated issues, BYO-auth

Status: accepted (2026-07-29; grilled as wayfinder ticket 07)

## Context

result-rpc's core is the closed per-procedure failure union. Generated procedures fold
agent-cms's `Data.TaggedError`s into wire-safe definitions the host's shells claim by tag.

## Decision

Five tags in the static `cms` namespace (defined once in the codegen runtime so definitions
merge into the host registry by reference):

| Tag | data | folded from |
|---|---|---|
| `cms/record-not-found` | `{ id }` | NotFoundError (Record/Version/Asset) |
| `cms/validation-failed` | `{ issues: [{ field?, message, code? }] }` | AggregateValidationError; plain ValidationError as one issue |
| `cms/duplicate` | `{ field?, message }` | DuplicateError |
| `cms/reference-conflict` | `{ references }` | ReferenceConflictError (record delete blockers, guarded asset delete) |
| `cms/schema-drift` | `{ procedure, detail }` | output-codec mismatch, or a missing model at runtime |

Deliberately absent: **auth tags** (BYO-auth — in-process there is no writeKey in the path; the
host's middleware contributes `Unauthorized` via the contract's `mutationErrors` merge) and
**model-not-found** (the model set is codegen-static; a missing model is drift). Unknown errors
throw → sanitized `server/internal` incidents. Bulk operations return per-id result arrays as
data, not failures.

Supporting decisions:
- **Validation aggregates.** Record write paths collect every field failure per submit
  (Dato-style whole-form mapping); `issues[]` always reflects reality, and each issue carries a
  machine-readable `code` (required/unique/format/enum/length/range/type/block_type/
  link_target/locale/structured_text).
- **Validation is a procedure.** `validate`/`validateUpdate` dry-runs share the exact
  validation code with the write paths, persist nothing, and power live form validation — the
  same architecture DatoCMS uses (observed: `POST /items/validate` per change).
- **Drift is shell-ownable**: every procedure declares `cms/schema-drift`; a host boundary
  shell renders "stale build — regenerate" distinguishably from crashes. A claims map ships
  (`cmsShellClaims`); no shell component does.
- **Audit via actor mapper**: `cmsProcedures(..., { actor: (ctx) => RequestActor|null })`
  records real editors in `_created_by`/`_updated_by`/`_published_by`.

## Consequences

Reads and writes have different unions (mechanically derived per operation). REST error bodies
mirror the same structure (`{ error, issues }`, `{ error, references }`, `{ error, entity, id }`).
