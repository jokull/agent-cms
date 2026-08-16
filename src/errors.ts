import { Schema } from "effect";

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
const ValidationIssueCodeSchema = Schema.Literals([
  "required",
  "unique",
  "format",
  "enum",
  "length",
  "range",
  "type",
  "block_type",
  "link_target",
  "locale",
  "structured_text",
] as const);

export type ValidationIssueCode = Schema.Schema.Type<typeof ValidationIssueCodeSchema>;

/** A single field-level validation issue within an aggregate. */
const ValidationIssueSchema = Schema.Struct({
  field: Schema.optional(Schema.String),
  message: Schema.String,
  /** Machine-readable validator identity — see {@link ValidationIssueCode}. */
  code: Schema.optional(ValidationIssueCodeSchema),
});

export type ValidationIssue = Schema.Schema.Type<typeof ValidationIssueSchema>;

/** Model/field/record not found */
export class NotFoundError extends Schema.TaggedError<NotFoundError>()("NotFoundError", {
  entity: Schema.String,
  id: Schema.String,
}) {}

/** Validation error (field values, DAST, API input) */
export class ValidationError extends Schema.TaggedError<ValidationError>()("ValidationError", {
  message: Schema.String,
  field: Schema.optional(Schema.String),
  /** Machine-readable validator identity — see {@link ValidationIssueCode}. */
  code: Schema.optional(ValidationIssueCodeSchema),
}) {}

/**
 * Aggregate of many field validation failures from a single write.
 *
 * Record create/patch validation accumulates every bad field instead of
 * aborting on the first (Dato-style whole-form error mapping), so a form can
 * mark every invalid field in one submit. A single-field failure still yields
 * an `issues` array of one — the array is always honest.
 */
export class AggregateValidationError extends Schema.TaggedError<AggregateValidationError>()("AggregateValidationError", {
  issues: Schema.Array(ValidationIssueSchema),
}) {}

/** Reference conflict — trying to delete something that's referenced */
export class ReferenceConflictError extends Schema.TaggedError<ReferenceConflictError>()("ReferenceConflictError", {
  message: Schema.String,
  references: Schema.Array(Schema.String),
}) {}

/** Duplicate — e.g., apiKey already exists */
export class DuplicateError extends Schema.TaggedError<DuplicateError>()("DuplicateError", {
  message: Schema.String,
}) {}

/** Schema engine error — DDL failed, migration issue */
export class SchemaEngineError extends Schema.TaggedError<SchemaEngineError>()("SchemaEngineError", {
  message: Schema.String,
  cause: Schema.optional(Schema.Unknown),
}) {}

/** Unauthorized access to a protected API surface */
export class UnauthorizedError extends Schema.TaggedError<UnauthorizedError>()("UnauthorizedError", {
  message: Schema.String,
}) {}

/**
 * The tagged union of all CMS errors. `toTaggedUnion` augments the union with
 * the matching utilities documented in SCHEMA.md: `match` for exhaustive
 * per-tag handling, `guards` for typed membership checks, `isAnyOf` for subset
 * checks — so discrimination never touches the raw `_tag` or `instanceof`.
 */
export const CmsErrorSchema = Schema.Union([
  NotFoundError,
  ValidationError,
  AggregateValidationError,
  ReferenceConflictError,
  DuplicateError,
  SchemaEngineError,
  UnauthorizedError,
]).pipe(Schema.toTaggedUnion("_tag"));

/** Union of all CMS errors */
export type CmsError = Schema.Schema.Type<typeof CmsErrorSchema>;

/** Runtime type guard for CmsError — `Schema.is` on the tagged union. */
// oxlint-disable-next-line anti-slop/no-unknown-parameters -- this type guard IS the boundary parser: it accepts the opaque error channel and narrows it via Schema.is.
export function isCmsError(error: unknown): error is CmsError {
  return Schema.is(CmsErrorSchema)(error);
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
  return CmsErrorSchema.match(error, {
    NotFoundError: (error) => ({
      status: 404,
      body: {
        error: `${error.entity} not found: ${error.id}`,
        entity: error.entity,
        id: error.id,
      },
    }),
    ValidationError: (error) => ({
      status: 400,
      body:
        error.field === undefined
          ? { error: error.message }
          : { error: error.message, field: error.field },
    }),
    AggregateValidationError: (error) => {
      const summary = error.issues.length === 1
        ? error.issues[0].message
        : `${error.issues.length} fields failed validation`;
      return { status: 400, body: { error: summary, issues: error.issues } };
    },
    ReferenceConflictError: (error) => ({
      status: 409,
      body: { error: error.message, references: error.references },
    }),
    DuplicateError: (error) => ({ status: 409, body: { error: error.message } }),
    SchemaEngineError: (error) => ({ status: 500, body: { error: error.message } }),
    UnauthorizedError: (error) => ({ status: 401, body: { error: error.message } }),
  });
}
