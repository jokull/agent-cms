import { Exit, Schema } from "effect";
import { isString, type DynamicRow, type StoredFieldValue } from "./dynamic/row-types.js";

const UnknownJson = Schema.fromJsonString(Schema.Unknown);
const JsonRecord = Schema.Record(Schema.String, Schema.Unknown);
const JsonRecordString = Schema.fromJsonString(JsonRecord);

// oxlint-disable-next-line anti-slop/no-unknown-parameters -- open JSON boundary: encodeJson serializes arbitrary JSON-serializable values (DTOs, arrays, error objects from catch blocks) to a string; the wrapped Schema.Unknown accepts any input and callers span every value kind.
export function encodeJson(value: unknown): string {
  return Schema.encodeSync(UnknownJson)(value);
}

/** Total decode — invalid JSON yields null; callers check the shape. */
export function decodeJsonString(input: string): StoredFieldValue {
  return decodeJsonStringOr(input, null);
}

export function tryDecodeJsonString(input: string) {
  const result = Schema.decodeUnknownExit(UnknownJson)(input);
  return Exit.isSuccess(result)
    ? { ok: true as const, value: result.value }
    : { ok: false as const };
}

export function decodeJsonStringOr(input: string, fallback: StoredFieldValue): StoredFieldValue {
  const parsed = tryDecodeJsonString(input);
  // SAFETY: Schema.fromJsonString(Schema.Unknown) yields well-formed JSON, which
  // is the stored-field-value universe (scalars, records, arrays); the union's
  // DynamicRow member carries the object/array forms at the type level.
  return parsed.ok ? (parsed.value as StoredFieldValue) : fallback;
}

export function decodeJsonRecordStringOr(
  input: string,
  fallback: DynamicRow,
): DynamicRow {
  const result = Schema.decodeUnknownExit(JsonRecordString)(input);
  return Exit.isSuccess(result) ? result.value : fallback;
}

export function decodeJsonIfString(value: StoredFieldValue): StoredFieldValue {
  if (!isString(value)) return value;
  return decodeJsonStringOr(value, value);
}
