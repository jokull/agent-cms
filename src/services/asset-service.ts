import { Context, Effect } from "effect";
import { SqlClient } from "@effect/sql";
import { ulid } from "ulidx";
import { NotFoundError, ValidationError } from "../errors.js";
import type { AssetRow } from "../db/row-types.js";
import type { CreateAssetInput, ImportAssetFromUrlInput } from "./input-schemas.js";
import { encodeJson } from "../json.js";

export class AssetImportContext extends Context.Tag("AssetImportContext")<
  AssetImportContext,
  {
    readonly r2Bucket: R2Bucket | undefined;
    readonly fetch: typeof globalThis.fetch;
  }
>() {}

function inferFilename(input: { url: string; filename?: string; mimeType?: string }) {
  if (input.filename && input.filename.length > 0) return input.filename;
  const pathname = new URL(input.url).pathname;
  const candidate = pathname.split("/").filter(Boolean).at(-1);
  if (candidate && candidate.length > 0) return decodeURIComponent(candidate);
  return input.mimeType?.startsWith("image/") ? `asset.${input.mimeType.slice(6)}` : "asset.bin";
}

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

export function searchAssets(opts: { query?: string; limit: number; offset: number }) {
  return Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const { query, limit, offset } = opts;

    if (query) {
      const pattern = `%${query}%`;
      const assets = yield* sql.unsafe<AssetRow>(
        `SELECT * FROM assets WHERE filename LIKE ? OR alt LIKE ? OR title LIKE ?
         ORDER BY created_at DESC LIMIT ? OFFSET ?`,
        [pattern, pattern, pattern, limit, offset]
      );
      const countRows = yield* sql.unsafe<{ total: number }>(
        `SELECT COUNT(*) as total FROM assets WHERE filename LIKE ? OR alt LIKE ? OR title LIKE ?`,
        [pattern, pattern, pattern]
      );
      return { assets: Array.from(assets), total: countRows[0]?.total ?? 0 };
    }

    const assets = yield* sql.unsafe<AssetRow>(
      "SELECT * FROM assets ORDER BY created_at DESC LIMIT ? OFFSET ?",
      [limit, offset]
    );
    const countRows = yield* sql.unsafe<{ total: number }>(
      "SELECT COUNT(*) as total FROM assets"
    );
    return { assets: Array.from(assets), total: countRows[0]?.total ?? 0 };
  });
}

export function updateAssetMetadata(id: string, body: { alt?: string; title?: string }) {
  return Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;

    const rows = yield* sql.unsafe<AssetRow>("SELECT * FROM assets WHERE id = ?", [id]);
    if (rows.length === 0) return yield* new NotFoundError({ entity: "Asset", id });

    const alt = body.alt !== undefined ? body.alt : rows[0].alt;
    const title = body.title !== undefined ? body.title : rows[0].title;

    yield* sql.unsafe(
      "UPDATE assets SET alt = ?, title = ? WHERE id = ?",
      [alt, title, id]
    );

    return { id, alt, title };
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

export function importAssetFromUrl(input: ImportAssetFromUrlInput) {
  return Effect.gen(function* () {
    const { r2Bucket, fetch } = yield* AssetImportContext;
    if (!r2Bucket) {
      return yield* new ValidationError({ message: "Asset import requires an R2 bucket binding" });
    }

    const filename = inferFilename(input);
    const id = ulid();
    const response = yield* Effect.tryPromise({
      try: () => fetch(input.url),
      catch: () => new ValidationError({ message: `Failed to fetch asset URL: ${input.url}` }),
    });
    if (!response.ok) {
      return yield* new ValidationError({
        message: `Failed to fetch asset URL: ${input.url} (${response.status})`,
      });
    }

    const mimeType = input.mimeType ?? response.headers.get("content-type")?.split(";")[0] ?? "application/octet-stream";
    const bytes = yield* Effect.tryPromise({
      try: () => response.arrayBuffer(),
      catch: () => new ValidationError({ message: `Failed to read asset bytes from: ${input.url}` }),
    });
    const r2Key = `uploads/${id}/${filename}`;

    yield* Effect.tryPromise({
      try: () => r2Bucket.put(r2Key, bytes, { httpMetadata: { contentType: mimeType } }),
      catch: () => new ValidationError({ message: `Failed to store asset in R2: ${filename}` }),
    });

    return yield* createAsset({
      id,
      filename,
      mimeType,
      size: bytes.byteLength,
      alt: input.alt,
      title: input.title,
      tags: input.tags,
      r2Key,
    });
  });
}
