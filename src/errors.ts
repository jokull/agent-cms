import { Data } from "effect";

/** Model/field/record not found */
export class NotFoundError extends Data.TaggedError("NotFoundError")<{
  readonly entity: string;
  readonly id: string;
}> {}

/** Validation error (field values, DAST, API input) */
export class ValidationError extends Data.TaggedError("ValidationError")<{
  readonly message: string;
  readonly field?: string;
  /** Machine-readable validator identity — see {@link ValidationIssueCode}. */
  readonly code?: ValidationIssueCode;
}> {}

/**
 * Machine-readable validator identity carried alongside a validation issue's
 * human message, mirroring Dato's `details.code` (e.g. `VALIDATION_REQUIRED`).
 * Consumers map it to per-field form state without parsing the message.
 *
 * Vocabulary:
 * - `required`        — a required field is empty.
 * - `unique`          — a unique field collides with another record.
 * - `format`          — a string fails an email/url/custom-pattern format check.
 * - `enum`            — a value is not one of the allowed enum values.
 * - `length`          — a string is shorter/longer than the length bounds.
 * - `range`           — a number/date falls outside its allowed range.
 * - `type`            — a value has the wrong shape for its field type
 *                       (composite decode failure, malformed link/media object,
 *                       missing linked record or asset).
 * - `block_type`      — a structured_text/rich_text block uses a disallowed type.
 * - `link_target`     — an itemLink/inlineItem references a disallowed model.
 * - `locale`          — a non-localized field got a locale-keyed value (or the
 *                       localized map itself is malformed).
 * - `structured_text` — a structured_text value fails DAST/blocks validation and
 *                       no more specific code applies.
 */
export type ValidationIssueCode =
  | "required"
  | "unique"
  | "format"
  | "enum"
  | "length"
  | "range"
  | "type"
  | "block_type"
  | "link_target"
  | "locale"
  | "structured_text";

/** A single field-level validation issue within an aggregate. */
export interface ValidationIssue {
  readonly field?: string;
  readonly message: string;
  /** Machine-readable validator identity — see {@link ValidationIssueCode}. */
  readonly code?: ValidationIssueCode;
}

/**
 * Aggregate of many field validation failures from a single write.
 *
 * Record create/patch validation accumulates every bad field instead of
 * aborting on the first (Dato-style whole-form error mapping), so a form can
 * mark every invalid field in one submit. A single-field failure still yields
 * an `issues` array of one — the array is always honest.
 */
export class AggregateValidationError extends Data.TaggedError("AggregateValidationError")<{
  readonly issues: ReadonlyArray<ValidationIssue>;
}> {}

/** Reference conflict — trying to delete something that's referenced */
export class ReferenceConflictError extends Data.TaggedError("ReferenceConflictError")<{
  readonly message: string;
  readonly references: readonly string[];
}> {}

/** Duplicate — e.g., apiKey already exists */
export class DuplicateError extends Data.TaggedError("DuplicateError")<{
  readonly message: string;
}> {}

/** Schema engine error — DDL failed, migration issue */
export class SchemaEngineError extends Data.TaggedError("SchemaEngineError")<{
  readonly message: string;
  readonly cause?: unknown;
}> {}

/** Unauthorized access to a protected API surface */
export class UnauthorizedError extends Data.TaggedError("UnauthorizedError")<{
  readonly message: string;
}> {}

/** Union of all CMS errors */
export type CmsError =
  | NotFoundError
  | ValidationError
  | AggregateValidationError
  | ReferenceConflictError
  | DuplicateError
  | SchemaEngineError
  | UnauthorizedError;

/**
 * The `_tag` discriminants of {@link CmsError}, kept in one place so the guard
 * below can never drift from the union. Data.TaggedError classes carry their
 * identity in `_tag` — matching it is the same mechanism `Effect.catchTag`
 * uses, and it survives duplicate class copies / realm boundaries that
 * `instanceof` does not.
 */
const cmsErrorTags = new Set<string>([
  "NotFoundError",
  "ValidationError",
  "AggregateValidationError",
  "ReferenceConflictError",
  "DuplicateError",
  "SchemaEngineError",
  "UnauthorizedError",
] as const);

/** Runtime type guard for CmsError */
export function isCmsError(error: unknown): error is CmsError {
  return typeof error === "object"
    && error !== null
    && "_tag" in error
    && typeof error._tag === "string"
    && cmsErrorTags.has(error._tag);
}

/** JSON body shapes emitted by errorToResponse, keyed by error tag */
export type ErrorResponseBody =
  | { error: string }
  | { error: string; field: string }
  | { error: string; issues: ReadonlyArray<ValidationIssue> }
  | { error: string; references: readonly string[] }
  | { error: string; entity: string; id: string };

/** Map a CMS error to an HTTP status code and JSON body */
export function errorToResponse(error: CmsError): { status: number; body: ErrorResponseBody } {
  switch (error._tag) {
    case "NotFoundError":
      return {
        status: 404,
        body: {
          error: `${error.entity} not found: ${error.id}`,
          entity: error.entity,
          id: error.id,
        },
      };
    case "ValidationError":
      return {
        status: 400,
        body:
          error.field === undefined
            ? { error: error.message }
            : { error: error.message, field: error.field },
      };
    case "AggregateValidationError": {
      const summary = error.issues.length === 1
        ? error.issues[0].message
        : `${error.issues.length} fields failed validation`;
      return { status: 400, body: { error: summary, issues: error.issues } };
    }
    case "ReferenceConflictError":
      return { status: 409, body: { error: error.message, references: error.references } };
    case "DuplicateError":
      return { status: 409, body: { error: error.message } };
    case "SchemaEngineError":
      return { status: 500, body: { error: error.message } };
    case "UnauthorizedError":
      return { status: 401, body: { error: error.message } };
  }
}
