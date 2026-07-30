/**
 * The canonical CMS error definitions. Browser-safe (no server imports).
 *
 * result-rpc maps one tag to exactly one definition (same reference), so these
 * live in a shared static module: the generated contract, the server runtime,
 * and the host's registry all import the *same* objects, and merging into the
 * host's app-wide registry is safe by construction.
 *
 * The taxonomy is settled by wayfinder ticket 07. Folding (server-side, in
 * server-runtime.ts) from agent-cms's `src/errors.ts`:
 *
 *   cms/record-not-found     ← NotFoundError (entity = Record)
 *   cms/validation-failed    ← AggregateValidationError, and plain ValidationError as one issue
 *   cms/duplicate            ← DuplicateError (field extracted from the message when derivable)
 *   cms/reference-conflict   ← ReferenceConflictError
 *   cms/schema-drift         ← output decode mismatch, and a missing model at runtime
 *
 * Deliberately NOT declared: no auth tags (BYO-auth — the host's middleware
 * contributes `Unauthorized`), no model-not-found (a missing model is drift, not
 * a domain outcome). `SchemaEngineError` and unknown defects stay server/internal.
 */
import { defineErrors, pickErrors, wire } from "result-rpc";

export const cmsErrors = defineErrors("cms", {
  recordNotFound: {
    data: wire.object({ id: wire.string }),
    httpStatus: 404,
  },
  validationFailed: {
    data: wire.object({
      issues: wire.array(
        wire.object({
          field: wire.optional(wire.string),
          message: wire.string,
          // Machine-readable validator identity (ValidationIssueCode in
          // agent-cms's src/errors.ts) — "required" | "unique" | "format" |
          // "enum" | "length" | "range" | "type" | "block_type" |
          // "link_target" | "locale" | "structured_text". Present at the
          // obvious construction sites; absent where the source raised none.
          code: wire.optional(wire.string),
        }),
      ),
    }),
    httpStatus: 400,
  },
  duplicate: {
    data: wire.object({
      field: wire.optional(wire.string),
      message: wire.string,
    }),
    httpStatus: 409,
  },
  referenceConflict: {
    data: wire.object({ references: wire.array(wire.string) }),
    httpStatus: 409,
  },
  schemaDrift: {
    data: wire.object({ procedure: wire.string, detail: wire.string }),
    httpStatus: 409,
  },
});

export type RecordNotFound = ReturnType<typeof cmsErrors.recordNotFound>;
export type ValidationFailed = ReturnType<typeof cmsErrors.validationFailed>;
export type Duplicate = ReturnType<typeof cmsErrors.duplicate>;
export type ReferenceConflict = ReturnType<typeof cmsErrors.referenceConflict>;
export type SchemaDrift = ReturnType<typeof cmsErrors.schemaDrift>;

/**
 * Errors a host *shell* typically claims rather than a component. `schemaDrift`
 * means "stale build — regenerate": no component recovers from it, so a
 * boundary shell owns it. See the README `boundaryShells` recipe.
 */
export const cmsShellClaims = pickErrors(cmsErrors, "schemaDrift");
