/**
 * Declared HTTP error schemas for the HttpApi surface (Wave 16).
 *
 * Each schema encodes a CmsError instance into the response body shape the
 * REST API has always produced (errorToResponse parity), with the matching
 * HTTP status annotated — so HttpApi routes replace the boundary
 * isCmsError/errorToResponse mapping with declared contracts.
 *
 * rc.109 drift note: `Schema.encodeTo`'s declared getter directions are
 * inverted vs the runtime. Probe-verified runtime behavior:
 *   - the DECODE getter receives the BODY and must produce the error
 *   - the ENCODE getter receives the ERROR and must produce the body
 * The declared types (decode: body -> unknown, encode: unknown -> body)
 * match that for the input sides; the encode getter's input is declared
 * `unknown` so the runtime error value requires one SAFETY cast per codec.
 */
import { Schema, SchemaGetter } from "effect";
import { HttpApiSchema } from "effect/unstable/httpapi";
import {
  AggregateValidationError,
  DuplicateError,
  NotFoundError,
  ReferenceConflictError,
  SchemaEngineError,
  UnauthorizedError,
  ValidationError,
} from "../errors.js";

const NotFoundBody = Schema.Struct({
  error: Schema.String,
  entity: Schema.String,
  id: Schema.String,
});

const ValidationBody = Schema.Struct({
  error: Schema.String,
  field: Schema.optional(Schema.String),
});

const AggregateValidationBody = Schema.Struct({
  error: Schema.String,
  issues: Schema.Array(
    Schema.Struct({
      message: Schema.String,
      field: Schema.optional(Schema.String),
      code: Schema.optional(Schema.String),
    }),
  ),
});

const ReferenceConflictBody = Schema.Struct({
  error: Schema.String,
  references: Schema.Array(Schema.String),
});

const DuplicateBody = Schema.Struct({ error: Schema.String });

const SchemaEngineBody = Schema.Struct({ error: Schema.String });

const UnauthorizedBody = Schema.Struct({ error: Schema.String });

const NotFoundApiError = Schema.encodeTo(NotFoundBody, {
  decode: SchemaGetter.transform((body: Schema.Schema.Type<typeof NotFoundBody>) =>
    new NotFoundError({ entity: body.entity, id: body.id })),
  // SAFETY: the encode getter receives the runtime error value (declared unknown).
  encode: SchemaGetter.transform((input: unknown) => {
    const error = input as NotFoundError;
    return {
      error: `${error.entity} not found: ${error.id}`,
      entity: error.entity,
      id: error.id,
    };
  }),
})(NotFoundError).pipe(HttpApiSchema.status(404));

const ValidationApiError = Schema.encodeTo(ValidationBody, {
  decode: SchemaGetter.transform((body: Schema.Schema.Type<typeof ValidationBody>) =>
    new ValidationError({ message: body.error, field: body.field })),
  // SAFETY: the encode getter receives the runtime error value (declared unknown).
  encode: SchemaGetter.transform((input: unknown) => {
    const error = input as ValidationError;
    // oxlint-disable-next-line anti-slop/no-conditional-empty-object-spread -- absent field must stay absent in JSON; the response transform coerces undefined to null.
    return { error: error.message, ...(error.field !== undefined ? { field: error.field } : {}) };
  }),
})(ValidationError).pipe(HttpApiSchema.status(400));

const AggregateValidationApiError = Schema.encodeTo(AggregateValidationBody, {
  decode: SchemaGetter.transform((body: Schema.Schema.Type<typeof AggregateValidationBody>) =>
    new AggregateValidationError({
      issues: body.issues.map((issue) => ({
        message: issue.message,
        field: issue.field,
        // SAFETY: the body's code is a plain string; the error's code is the
        // validated union — the value already passed ValidationIssueCodeSchema.
        code: issue.code as never,
      })),
    })),
  // SAFETY: the encode getter receives the runtime error value (declared unknown).
  encode: SchemaGetter.transform((input: unknown) => {
    const error = input as AggregateValidationError;
    return {
      error: error.issues.length === 1
        ? error.issues[0].message
        : `${error.issues.length} fields failed validation`,
      issues: error.issues.map((issue) => ({
        message: issue.message,
        field: issue.field,
        code: issue.code,
      })),
    };
  }),
})(AggregateValidationError).pipe(HttpApiSchema.status(400));

const ReferenceConflictApiError = Schema.encodeTo(ReferenceConflictBody, {
  decode: SchemaGetter.transform((body: Schema.Schema.Type<typeof ReferenceConflictBody>) =>
    new ReferenceConflictError({ message: body.error, references: [...body.references] })),
  // SAFETY: the encode getter receives the runtime error value (declared unknown).
  encode: SchemaGetter.transform((input: unknown) => {
    const error = input as ReferenceConflictError;
    return { error: error.message, references: [...error.references] };
  }),
})(ReferenceConflictError).pipe(HttpApiSchema.status(409));

const DuplicateApiError = Schema.encodeTo(DuplicateBody, {
  decode: SchemaGetter.transform((body: Schema.Schema.Type<typeof DuplicateBody>) =>
    new DuplicateError({ message: body.error })),
  // SAFETY: the encode getter receives the runtime error value (declared unknown).
  encode: SchemaGetter.transform((input: unknown) => {
    const error = input as DuplicateError;
    return { error: error.message };
  }),
})(DuplicateError).pipe(HttpApiSchema.status(409));

const SchemaEngineApiError = Schema.encodeTo(SchemaEngineBody, {
  decode: SchemaGetter.transform((body: Schema.Schema.Type<typeof SchemaEngineBody>) =>
    new SchemaEngineError({ message: body.error })),
  // SAFETY: the encode getter receives the runtime error value (declared unknown).
  encode: SchemaGetter.transform((input: unknown) => {
    const error = input as SchemaEngineError;
    return { error: error.message };
  }),
})(SchemaEngineError).pipe(HttpApiSchema.status(500));

const UnauthorizedApiError = Schema.encodeTo(UnauthorizedBody, {
  decode: SchemaGetter.transform((body: Schema.Schema.Type<typeof UnauthorizedBody>) =>
    new UnauthorizedError({ message: body.error })),
  // SAFETY: the encode getter receives the runtime error value (declared unknown).
  encode: SchemaGetter.transform((input: unknown) => {
    const error = input as UnauthorizedError;
    return { error: error.message };
  }),
})(UnauthorizedError).pipe(HttpApiSchema.status(401));

/**
 * The HttpApi `error:` contract — one codec per error so each carries its own
 * status annotation (a union would resolve to the 500 fallback).
 */
export const CmsApiErrorList = [
  NotFoundApiError,
  ValidationApiError,
  AggregateValidationApiError,
  ReferenceConflictApiError,
  DuplicateApiError,
  SchemaEngineApiError,
  UnauthorizedApiError,
] as const;

/** Union of every declared API error — for narrowing/validation use. */
export const CmsApiErrors = Schema.Union(CmsApiErrorList);
