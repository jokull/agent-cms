import { Effect } from "effect";
import { SqlClient } from "@effect/sql";
import { ulid } from "ulidx";
import { DuplicateError } from "../errors.js";
import type { LocaleRow } from "../db/row-types.js";
import { removeLocale as removeLocaleWithCleanup } from "./schema-lifecycle.js";
import type { CreateLocaleInput } from "./input-schemas.js";

export function listLocales() {
  return Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    return yield* sql.unsafe<LocaleRow>("SELECT * FROM locales ORDER BY position");
  });
}

export function createLocale(body: CreateLocaleInput) {
  return Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;

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
  // Delegate to schema-lifecycle which strips locale keys from all
  // localized field values before deleting the locale row
  return removeLocaleWithCleanup(id);
}
