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

/** Union of all CMS errors */
export type CmsError =
  | NotFoundError
  | ValidationError
  | ReferenceConflictError
  | DuplicateError
  | SchemaEngineError;

const CMS_ERROR_TAGS = new Set<string>([
  "NotFoundError", "ValidationError", "ReferenceConflictError",
  "DuplicateError", "SchemaEngineError",
]);

/** Runtime type guard for CmsError — checks _tag without unsafe casts */
export function isCmsError(error: unknown): error is CmsError {
  return typeof error === "object" && error !== null && "_tag" in error &&
    CMS_ERROR_TAGS.has((error as { _tag: string })._tag);
}

/** Map a CMS error to an HTTP status code and JSON body */
export function errorToResponse(error: CmsError): { status: number; body: { error: string } } {
  switch (error._tag) {
    case "NotFoundError":
      return { status: 404, body: { error: `${error.entity} not found: ${error.id}` } };
    case "ValidationError":
      return { status: 400, body: { error: error.message } };
    case "ReferenceConflictError":
      return { status: 409, body: { error: error.message } };
    case "DuplicateError":
      return { status: 409, body: { error: error.message } };
    case "SchemaEngineError":
      return { status: 500, body: { error: error.message } };
  }
}
