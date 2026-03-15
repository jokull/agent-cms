import { Effect } from "effect";
import { SqlClient } from "@effect/sql";
import { ulid } from "ulidx";
import { NotFoundError, ValidationError, DuplicateError } from "../errors.js";

export function listLocales() {
  return Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    return yield* sql.unsafe<Record<string, any>>("SELECT * FROM locales ORDER BY position");
  });
}

export function createLocale(body: any) {
  return Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;

    if (!body.code || typeof body.code !== "string")
      return yield* new ValidationError({ message: "code is required (e.g. 'en', 'is')" });

    const existing = yield* sql.unsafe<{ id: string }>("SELECT id FROM locales WHERE code = ?", [body.code]);
    if (existing.length > 0)
      return yield* new DuplicateError({ message: `Locale '${body.code}' already exists` });

    const allLocales = yield* sql.unsafe<{ id: string }>("SELECT id FROM locales");
    const id = ulid();

    yield* sql.unsafe(
      "INSERT INTO locales (id, code, position, fallback_locale_id) VALUES (?, ?, ?, ?)",
      [id, body.code, body.position ?? allLocales.length, body.fallbackLocaleId ?? null]
    );

    return { id, code: body.code, position: body.position ?? allLocales.length, fallbackLocaleId: body.fallbackLocaleId ?? null };
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
