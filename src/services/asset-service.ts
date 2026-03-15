import { Effect } from "effect";
import { SqlClient } from "@effect/sql";
import { ulid } from "ulidx";
import { NotFoundError, ValidationError } from "../errors.js";

export function createAsset(body: any) {
  return Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;

    if (!body.filename || typeof body.filename !== "string")
      return yield* new ValidationError({ message: "filename is required" });
    if (!body.mimeType || typeof body.mimeType !== "string")
      return yield* new ValidationError({ message: "mimeType is required" });

    const now = new Date().toISOString();
    const id = ulid();

    yield* sql.unsafe(
      `INSERT INTO assets (id, filename, mime_type, size, width, height, alt, title, r2_key, blurhash, colors, focal_point, tags, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        id, body.filename, body.mimeType,
        body.size ?? 0, body.width ?? null, body.height ?? null,
        body.alt ?? null, body.title ?? null,
        body.r2Key ?? `uploads/${id}/${body.filename}`,
        body.blurhash ?? null,
        body.colors ? JSON.stringify(body.colors) : null,
        body.focalPoint ? JSON.stringify(body.focalPoint) : null,
        JSON.stringify(body.tags ?? []),
        now,
      ]
    );

    return { id, filename: body.filename, mimeType: body.mimeType, size: body.size ?? 0, width: body.width, height: body.height, alt: body.alt, title: body.title, r2Key: body.r2Key ?? `uploads/${id}/${body.filename}`, createdAt: now };
  });
}

export function listAssets() {
  return Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    return yield* sql.unsafe<Record<string, any>>("SELECT * FROM assets ORDER BY created_at DESC");
  });
}

export function getAsset(id: string) {
  return Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const rows = yield* sql.unsafe<Record<string, any>>("SELECT * FROM assets WHERE id = ?", [id]);
    if (rows.length === 0) return yield* new NotFoundError({ entity: "Asset", id });
    return rows[0];
  });
}

export function deleteAsset(id: string) {
  return Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const rows = yield* sql.unsafe<{ id: string }>("SELECT id FROM assets WHERE id = ?", [id]);
    if (rows.length === 0) return yield* new NotFoundError({ entity: "Asset", id });
    yield* sql.unsafe("DELETE FROM assets WHERE id = ?", [id]);
    return { deleted: true };
  });
}
