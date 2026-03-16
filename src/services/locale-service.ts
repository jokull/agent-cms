import { Effect, Schema } from "effect";
import { SqlClient } from "@effect/sql";
import { ulid } from "ulidx";
import { NotFoundError, ValidationError, DuplicateError } from "../errors.js";
import type { LocaleRow } from "../db/row-types.js";
import { CreateLocaleInput } from "./input-schemas.js";

export function listLocales() {
  return Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    return yield* sql.unsafe<LocaleRow>("SELECT * FROM locales ORDER BY position");
  });
}

export function createLocale(rawBody: unknown) {
  return Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;

    const body = yield* Schema.decodeUnknown(CreateLocaleInput)(rawBody).pipe(
      Effect.mapError((e) => new ValidationError({ message: `Invalid input: ${e.message}` }))
    );

    const existing = yield* sql.unsafe<{ id: string }>("SELECT id FROM locales WHERE code = ?", [body.code]);
    if (existing.length > 0)
      return yield* new DuplicateError({ message: `Locale '${body.code}' already exists` });

    const allLocales = yield* sql.unsafe<{ id: string }>("SELECT id FROM locales");
    const id = ulid();
    const position = body.position ?? allLocales.length;

    yield* sql.unsafe(
      "INSERT INTO locales (id, code, position, fallback_locale_id) VALUES (?, ?, ?, ?)",
      [id, body.code, position, body.fallbackLocaleId ?? null]
    );

    return { id, code: body.code, position, fallbackLocaleId: body.fallbackLocaleId ?? null };
  });
}

export function deleteLocale(id: string) {
  return Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const rows = yield* sql.unsafe<{ id: string }>("SELECT id FROM locales WHERE id = ?", [id]);
    if (rows.length === 0) return yield* new NotFoundError({ entity: "Locale", id });
    yield* sql.unsafe("DELETE FROM locales WHERE id = ?", [id]);
    return { deleted: true };
  });
}
