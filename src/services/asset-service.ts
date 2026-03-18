import { Effect } from "effect";
import { SqlClient } from "@effect/sql";
import { ulid } from "ulidx";
import { NotFoundError, ValidationError } from "../errors.js";
import type { AssetRow } from "../db/row-types.js";
import type { CreateAssetInput } from "./input-schemas.js";
import { encodeJson } from "../json.js";

export function createAsset(body: CreateAssetInput) {
  return Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;

    const now = new Date().toISOString();
    const id = body.id ?? ulid();

    const existing = yield* sql.unsafe<{ id: string }>("SELECT id FROM assets WHERE id = ?", [id]);
    if (existing.length > 0) {
      return yield* new ValidationError({ message: `Asset with id '${id}' already exists` });
    }

    yield* sql.unsafe(
      `INSERT INTO assets (id, filename, mime_type, size, width, height, alt, title, r2_key, blurhash, colors, focal_point, tags, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        id, body.filename, body.mimeType,
        body.size, body.width ?? null, body.height ?? null,
        body.alt ?? null, body.title ?? null,
        body.r2Key ?? `uploads/${id}/${body.filename}`,
        body.blurhash ?? null,
        body.colors ? encodeJson(body.colors) : null,
        body.focalPoint ? encodeJson(body.focalPoint) : null,
        encodeJson(body.tags),
        now,
      ]
    );

    return { id, filename: body.filename, mimeType: body.mimeType, size: body.size, width: body.width, height: body.height, alt: body.alt, title: body.title, r2Key: body.r2Key ?? `uploads/${id}/${body.filename}`, createdAt: now };
  });
}

export function listAssets() {
  return Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    return yield* sql.unsafe<AssetRow>("SELECT * FROM assets ORDER BY created_at DESC");
  });
}

export function getAsset(id: string) {
  return Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const rows = yield* sql.unsafe<AssetRow>("SELECT * FROM assets WHERE id = ?", [id]);
    if (rows.length === 0) return yield* new NotFoundError({ entity: "Asset", id });
    return rows[0];
  });
}

/**
 * Replace an asset's file while keeping the same ID and URL.
 * Updates metadata (filename, mimeType, size, dimensions, r2Key) but the asset ID
 * and all content references remain stable. DatoCMS can't do this (imgix regenerates URLs).
 */
export function replaceAsset(id: string, body: CreateAssetInput) {
  return Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;

    const rows = yield* sql.unsafe<AssetRow>("SELECT * FROM assets WHERE id = ?", [id]);
    if (rows.length === 0) return yield* new NotFoundError({ entity: "Asset", id });

    const r2Key = body.r2Key ?? `uploads/${id}/${body.filename}`;

    yield* sql.unsafe(
      `UPDATE assets SET filename = ?, mime_type = ?, size = ?, width = ?, height = ?,
       alt = ?, title = ?, r2_key = ?, blurhash = ?, colors = ?, focal_point = ?, tags = ?
       WHERE id = ?`,
      [
        body.filename, body.mimeType, body.size,
        body.width ?? null, body.height ?? null,
        body.alt ?? rows[0].alt, body.title ?? rows[0].title,
        r2Key,
        body.blurhash ?? null,
        body.colors ? encodeJson(body.colors) : null,
        body.focalPoint ? encodeJson(body.focalPoint) : null,
        encodeJson(body.tags),
        id,
      ]
    );

    return {
      id, filename: body.filename, mimeType: body.mimeType, size: body.size,
      width: body.width, height: body.height,
      alt: body.alt ?? rows[0].alt, title: body.title ?? rows[0].title,
      r2Key, replaced: true,
    };
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
