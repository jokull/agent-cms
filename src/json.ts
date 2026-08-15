import { Exit, Schema } from "effect";

const UnknownJson = Schema.fromJsonString(Schema.Unknown);
const JsonRecord = Schema.Record(Schema.String, Schema.Unknown);
const JsonRecordString = Schema.fromJsonString(JsonRecord);

export function encodeJson(value: unknown): string {
  return Schema.encodeSync(UnknownJson)(value);
}

export function decodeJsonString(input: string): unknown {
  return Schema.decodeUnknownSync(UnknownJson)(input);
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
  fallback: Record<string, unknown>,
): Record<string, unknown> {
  const result = Schema.decodeUnknownExit(JsonRecordString)(input);
  return Exit.isSuccess(result) ? result.value : fallback;
}

export function decodeJsonIfString(value: unknown): unknown {
  if (typeof value !== "string") return value;
  return decodeJsonStringOr(value, value);
}
