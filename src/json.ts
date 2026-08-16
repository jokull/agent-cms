import { Exit, Schema } from "effect";
import { isString, type DynamicRow } from "./dynamic/row-types.js";

const UnknownJson = Schema.fromJsonString(Schema.Unknown);
const JsonRecord = Schema.Record(Schema.String, Schema.Unknown);
const JsonRecordString = Schema.fromJsonString(JsonRecord);

export function encodeJson(value: unknown): string {
  return Schema.encodeSync(UnknownJson)(value);
}

/** Total decode — invalid JSON yields null; callers check the shape. */
export function decodeJsonString(input: string): unknown {
  return decodeJsonStringOr(input, null);
}

export function tryDecodeJsonString(input: string) {
  const result = Schema.decodeUnknownExit(UnknownJson)(input);
  return Exit.isSuccess(result)
    ? { ok: true as const, value: result.value }
    : { ok: false as const };
}

export function decodeJsonStringOr(input: string, fallback: unknown): unknown {
  const parsed = tryDecodeJsonString(input);
  return parsed.ok ? parsed.value : fallback;
}

export function decodeJsonRecordStringOr(
  input: string,
  fallback: DynamicRow,
): DynamicRow {
  const result = Schema.decodeUnknownExit(JsonRecordString)(input);
  return Exit.isSuccess(result) ? result.value : fallback;
}

export function decodeJsonIfString(value: unknown): unknown {
  if (!isString(value)) return value;
  return decodeJsonStringOr(value, value);
}
