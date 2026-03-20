import { Context, Effect } from "effect";
import { SqlClient } from "@effect/sql";
import { ulid } from "ulidx";
import { NotFoundError, ValidationError } from "../errors.js";
import type { AssetRow } from "../db/row-types.js";
import type { CreateAssetInput, ImportAssetFromUrlInput } from "./input-schemas.js";
import { encodeJson } from "../json.js";
import type { RequestActor } from "../attribution.js";

export class AssetImportContext extends Context.Tag("AssetImportContext")<
  AssetImportContext,
  {
    readonly r2Bucket: R2Bucket | undefined;
    readonly fetch: typeof globalThis.fetch;
  }
>() {}

const MAX_REMOTE_ASSET_BYTES = 25 * 1024 * 1024;

function normalizeHostname(hostname: string) {
  return hostname.replace(/^\[|\]$/g, "").toLowerCase();
}

function isPrivateIpv4(hostname: string) {
  if (!/^\d{1,3}(?:\.\d{1,3}){3}$/.test(hostname)) return false;
  const octets = hostname.split(".").map(Number);
  if (octets.some((octet) => Number.isNaN(octet) || octet < 0 || octet > 255)) return false;
  return octets[0] === 10
    || octets[0] === 127
    || (octets[0] === 169 && octets[1] === 254)
    || (octets[0] === 172 && octets[1] >= 16 && octets[1] <= 31)
    || (octets[0] === 192 && octets[1] === 168);
}

function isPrivateIpv6(hostname: string) {
  const normalized = normalizeHostname(hostname);
  return normalized === "::1"
    || normalized.startsWith("fc")
    || normalized.startsWith("fd")
    || normalized.startsWith("fe80:");
}

function isBlockedHostname(hostname: string) {
  const normalized = normalizeHostname(hostname);
  return normalized === "localhost"
    || normalized.endsWith(".localhost")
    || normalized.endsWith(".local")
    || normalized.endsWith(".internal")
    || isPrivateIpv4(normalized)
    || isPrivateIpv6(normalized);
}

function validateRemoteAssetUrl(input: string) {
  return Effect.try({
    try: () => new URL(input),
    catch: () => new ValidationError({ message: "Asset URL must be a valid http:// or https:// URL" }),
  }).pipe(
    Effect.flatMap((url) => {
      if (url.protocol !== "http:" && url.protocol !== "https:") {
        return new ValidationError({ message: "Asset URL must use http:// or https://" });
      }
      if (!url.hostname || isBlockedHostname(url.hostname)) {
        return new ValidationError({ message: `Asset URL host is not allowed: ${url.hostname || "<empty>"}` });
      }
      if (url.username || url.password) {
        return new ValidationError({ message: "Asset URL must not contain embedded credentials" });
      }
      return Effect.succeed(url);
    }),
  );
}

function parseContentLength(header: string | null) {
  if (!header) return null;
  const parsed = Number(header);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : null;
}

function readResponseBytes(response: Response, url: string) {
  return Effect.gen(function* () {
    const contentLength = parseContentLength(response.headers.get("content-length"));
    if (contentLength !== null && contentLength > MAX_REMOTE_ASSET_BYTES) {
      return yield* new ValidationError({
        message: `Asset URL is too large to import (${contentLength} bytes > ${MAX_REMOTE_ASSET_BYTES} byte limit)`,
      });
    }

    if (!response.body) {
      return new Uint8Array();
    }

    const reader = response.body.getReader();
    const chunks: Uint8Array[] = [];
    let total = 0;

    let done = false;
    while (!done) {
      const chunk = yield* Effect.tryPromise({
        try: () => reader.read(),
        catch: () => new ValidationError({ message: `Failed to read asset bytes from: ${url}` }),
      });
      if (chunk.done) {
        done = true;
        continue;
      }
      const value = chunk.value;
      total += value.byteLength;
      if (total > MAX_REMOTE_ASSET_BYTES) {
        return yield* new ValidationError({
          message: `Asset URL is too large to import (${total} bytes > ${MAX_REMOTE_ASSET_BYTES} byte limit)`,
        });
      }
      chunks.push(value);
    }

    const bytes = new Uint8Array(total);
    let offset = 0;
    for (const chunk of chunks) {
      bytes.set(chunk, offset);
      offset += chunk.byteLength;
    }
    return bytes;
  });
}

function inferFilename(input: { url: string; filename?: string; mimeType?: string }) {
  if (input.filename && input.filename.length > 0) return input.filename;
  const pathname = new URL(input.url).pathname;
  const candidate = pathname.split("/").filter(Boolean).at(-1);
  if (candidate && candidate.length > 0) return decodeURIComponent(candidate);
  return input.mimeType?.startsWith("image/") ? `asset.${input.mimeType.slice(6)}` : "asset.bin";
}

export function createAsset(body: CreateAssetInput, actor?: RequestActor | null) {
  return Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;

    const now = new Date().toISOString();
    const id = body.id ?? ulid();

    const existing = yield* sql.unsafe<{ id: string }>("SELECT id FROM assets WHERE id = ?", [id]);
    if (existing.length > 0) {
      return yield* new ValidationError({ message: `Asset with id '${id}' already exists` });
    }

    yield* sql.unsafe(
      `INSERT INTO assets (id, filename, mime_type, size, width, height, alt, title, r2_key, blurhash, colors, focal_point, tags, created_at, updated_at, created_by, updated_by)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
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
        now,
        actor?.label ?? null,
        actor?.label ?? null,
      ]
    );

    return {
      id,
      filename: body.filename,
      mimeType: body.mimeType,
      size: body.size,
      width: body.width,
      height: body.height,
      alt: body.alt,
      title: body.title,
      r2Key: body.r2Key ?? `uploads/${id}/${body.filename}`,
      createdAt: now,
      updatedAt: now,
      createdBy: actor?.label ?? null,
      updatedBy: actor?.label ?? null,
    };
  }).pipe(
    Effect.withSpan("asset.create"),
    Effect.annotateSpans({
      assetId: body.id ?? "",
      filename: body.filename,
      actorType: actor?.type ?? "anonymous",
    }),
  );
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
export function replaceAsset(id: string, body: CreateAssetInput, actor?: RequestActor | null) {
  return Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;

    const rows = yield* sql.unsafe<AssetRow>("SELECT * FROM assets WHERE id = ?", [id]);
    if (rows.length === 0) return yield* new NotFoundError({ entity: "Asset", id });

    const r2Key = body.r2Key ?? `uploads/${id}/${body.filename}`;

    const now = new Date().toISOString();
    yield* sql.unsafe(
      `UPDATE assets SET filename = ?, mime_type = ?, size = ?, width = ?, height = ?,
       alt = ?, title = ?, r2_key = ?, blurhash = ?, colors = ?, focal_point = ?, tags = ?, updated_at = ?, updated_by = ?
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
        now,
        actor?.label ?? null,
        id,
      ]
    );

    return {
      id, filename: body.filename, mimeType: body.mimeType, size: body.size,
      width: body.width, height: body.height,
      alt: body.alt ?? rows[0].alt, title: body.title ?? rows[0].title,
      r2Key, replaced: true, updatedAt: now, updatedBy: actor?.label ?? null,
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

export function updateAssetMetadata(id: string, body: { alt?: string; title?: string }, actor?: RequestActor | null) {
  return Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;

    const rows = yield* sql.unsafe<AssetRow>("SELECT * FROM assets WHERE id = ?", [id]);
    if (rows.length === 0) return yield* new NotFoundError({ entity: "Asset", id });

    const alt = body.alt !== undefined ? body.alt : rows[0].alt;
    const title = body.title !== undefined ? body.title : rows[0].title;

    const now = new Date().toISOString();
    yield* sql.unsafe(
      "UPDATE assets SET alt = ?, title = ?, updated_at = ?, updated_by = ? WHERE id = ?",
      [alt, title, now, actor?.label ?? null, id]
    );

    return { id, alt, title, updatedAt: now, updatedBy: actor?.label ?? null };
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

export function importAssetFromUrl(input: ImportAssetFromUrlInput, actor?: RequestActor | null) {
  return Effect.gen(function* () {
    const { r2Bucket, fetch } = yield* AssetImportContext;
    if (!r2Bucket) {
      return yield* new ValidationError({ message: "Asset import requires an R2 bucket binding" });
    }

    const url = yield* validateRemoteAssetUrl(input.url);
    const filename = inferFilename(input);
    const id = ulid();
    const response = yield* Effect.tryPromise({
      try: () => fetch(url, { redirect: "manual" }),
      catch: () => new ValidationError({ message: `Failed to fetch asset URL: ${input.url}` }),
    });
    if (response.status >= 300 && response.status < 400) {
      return yield* new ValidationError({
        message: `Redirects are not allowed when importing assets from URL: ${input.url}`,
      });
    }
    if (!response.ok) {
      return yield* new ValidationError({
        message: `Failed to fetch asset URL: ${input.url} (${response.status})`,
      });
    }

    const mimeType = input.mimeType ?? response.headers.get("content-type")?.split(";")[0] ?? "application/octet-stream";
    const bytes = yield* readResponseBytes(response, input.url);
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
    }, actor);
  }).pipe(
    Effect.withSpan("asset.import_from_url"),
    Effect.annotateSpans({
      url: input.url,
      actorType: actor?.type ?? "anonymous",
    }),
  );
}
