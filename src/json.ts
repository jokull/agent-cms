import * as Either from "effect/Either";
import { Schema } from "effect";

const UnknownJson = Schema.parseJson();
const JsonRecord = Schema.Record({ key: Schema.String, value: Schema.Unknown });
const JsonRecordString = Schema.parseJson(JsonRecord);

export function encodeJson(value: unknown): string {
  return Schema.encodeSync(UnknownJson)(value);
}

export function decodeJsonString(input: string): unknown {
  return Schema.decodeUnknownSync(UnknownJson)(input);
}

export function tryDecodeJsonString(input: string): unknown | undefined {
  const result = Schema.decodeUnknownEither(UnknownJson)(input);
  return Either.isRight(result) ? result.right : undefined;
}

export function decodeJsonStringOr<A>(input: string, fallback: A): unknown | A {
  const parsed = tryDecodeJsonString(input);
  return parsed === undefined ? fallback : parsed;
}

export function decodeJsonRecordStringOr(
  input: string,
  fallback: Record<string, unknown>,
): Record<string, unknown> {
  const result = Schema.decodeUnknownEither(JsonRecordString)(input);
  return Either.isRight(result) ? result.right : fallback;
}

export function decodeJsonIfString(value: unknown): unknown {
  if (typeof value !== "string") return value;
  return decodeJsonStringOr(value, value);
}
