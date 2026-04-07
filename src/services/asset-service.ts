import { Context, Effect } from "effect";
import { SqlClient } from "@effect/sql";
import { generateId } from "../id.js";
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
const MAX_REMOTE_ASSET_REDIRECTS = 5;

function getAssetBasename(filename: string) {
  const lastDot = filename.lastIndexOf(".");
  return lastDot > 0 ? filename.slice(0, lastDot) : filename;
}

function getAssetFormat(filename: string, mimeType: string) {
  const lastDot = filename.lastIndexOf(".");
  if (lastDot > 0 && lastDot < filename.length - 1) {
    return filename.slice(lastDot + 1).toLowerCase();
  }
  const mimeSubtype = mimeType.split("/")[1];
  return mimeSubtype?.toLowerCase() ?? "bin";
}

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

function isRedirectStatus(status: number) {
  return status === 301 || status === 302 || status === 303 || status === 307 || status === 308;
}

function fetchRemoteAsset(url: URL, fetchFn: typeof globalThis.fetch) {
  return Effect.gen(function* () {
    let currentUrl = url;

    for (let redirectCount = 0; redirectCount <= MAX_REMOTE_ASSET_REDIRECTS; redirectCount += 1) {
      const response = yield* Effect.tryPromise({
        try: () => fetchFn(currentUrl, { redirect: "manual" }),
        catch: () => new ValidationError({ message: `Failed to fetch asset URL: ${currentUrl}` }),
      });

      if (!isRedirectStatus(response.status)) {
        return { response, resolvedUrl: currentUrl };
      }

      const location = response.headers.get("location");
      if (!location) {
        return yield* new ValidationError({
          message: `Asset URL redirect is missing a Location header: ${currentUrl}`,
        });
      }

      if (redirectCount === MAX_REMOTE_ASSET_REDIRECTS) {
        return yield* new ValidationError({
          message: `Asset URL redirected too many times (>${MAX_REMOTE_ASSET_REDIRECTS}): ${url}`,
        });
      }

      const nextUrl = yield* validateRemoteAssetUrl(new URL(location, currentUrl).toString());
      currentUrl = nextUrl;
    }

    return yield* new ValidationError({ message: `Failed to resolve asset URL: ${url}` });
  });
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

/**
 * Extract image dimensions by reading file headers.
 * Supports PNG, JPEG, GIF, WebP, and BMP. Returns null for unrecognized formats.
 */
function detectImageDimensions(bytes: Uint8Array, mimeType: string): { width: number; height: number } | null {
  if (!mimeType.startsWith("image/") || bytes.length < 24) return null;

  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);

  // PNG: bytes 16-23 contain width and height as 32-bit big-endian
  if (bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4E && bytes[3] === 0x47) {
    return { width: view.getUint32(16), height: view.getUint32(20) };
  }

  // GIF: bytes 6-9 contain width and height as 16-bit little-endian
  if (bytes[0] === 0x47 && bytes[1] === 0x49 && bytes[2] === 0x46) {
    return { width: view.getUint16(6, true), height: view.getUint16(8, true) };
  }

  // BMP: bytes 18-25 contain width and height as 32-bit little-endian
  if (bytes[0] === 0x42 && bytes[1] === 0x4D && bytes.length >= 26) {
    return { width: view.getInt32(18, true), height: Math.abs(view.getInt32(22, true)) };
  }

  // WebP: RIFF....WEBP, then VP8 chunk
  if (bytes[0] === 0x52 && bytes[1] === 0x49 && bytes[2] === 0x46 && bytes[3] === 0x46 &&
      bytes[8] === 0x57 && bytes[9] === 0x45 && bytes[10] === 0x42 && bytes[11] === 0x50) {
    // VP8L (lossless)
    if (bytes[12] === 0x56 && bytes[13] === 0x50 && bytes[14] === 0x38 && bytes[15] === 0x4C && bytes.length >= 25) {
      const bits = view.getUint32(21, true);
      return { width: (bits & 0x3FFF) + 1, height: ((bits >> 14) & 0x3FFF) + 1 };
    }
    // VP8X (extended)
    if (bytes[12] === 0x56 && bytes[13] === 0x50 && bytes[14] === 0x38 && bytes[15] === 0x58 && bytes.length >= 30) {
      const w = 1 + (bytes[24] | (bytes[25] << 8) | (bytes[26] << 16));
      const h = 1 + (bytes[27] | (bytes[28] << 8) | (bytes[29] << 16));
      return { width: w, height: h };
    }
    // VP8 (lossy)
    if (bytes[12] === 0x56 && bytes[13] === 0x50 && bytes[14] === 0x38 && bytes[15] === 0x20 && bytes.length >= 30) {
      // Frame header starts at byte 20, skip 3-byte frame tag + 3-byte start code
      const offset = 26;
      if (bytes.length >= offset + 4) {
        return { width: view.getUint16(offset, true) & 0x3FFF, height: view.getUint16(offset + 2, true) & 0x3FFF };
      }
    }
  }

  // JPEG: scan for SOF0/SOF2 marker
  if (bytes[0] === 0xFF && bytes[1] === 0xD8) {
    let i = 2;
    while (i < bytes.length - 9) {
      if (bytes[i] !== 0xFF) { i++; continue; }
      const marker = bytes[i + 1];
      // SOF0, SOF1, SOF2, SOF3
      if (marker >= 0xC0 && marker <= 0xC3) {
        return { width: view.getUint16(i + 7), height: view.getUint16(i + 5) };
      }
      // Skip this segment
      const segmentLength = view.getUint16(i + 2);
      i += 2 + segmentLength;
    }
  }

  return null;
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
    const id = body.id ?? generateId();

    const existing = yield* sql.unsafe<{ id: string }>("SELECT id FROM assets WHERE id = ?", [id]);
    if (existing.length > 0) {
      return yield* new ValidationError({ message: `Asset with id '${id}' already exists` });
    }

    yield* sql.unsafe(
      `INSERT INTO assets (id, filename, basename, format, mime_type, size, width, height, alt, title, r2_key, blurhash, colors, focal_point, tags, created_at, updated_at, created_by, updated_by)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        id, body.filename, getAssetBasename(body.filename), getAssetFormat(body.filename, body.mimeType), body.mimeType,
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
      `UPDATE assets SET filename = ?, basename = ?, format = ?, mime_type = ?, size = ?, width = ?, height = ?,
       alt = ?, title = ?, r2_key = ?, blurhash = ?, colors = ?, focal_point = ?, tags = ?, updated_at = ?, updated_by = ?
       WHERE id = ?`,
      [
        body.filename, getAssetBasename(body.filename), getAssetFormat(body.filename, body.mimeType), body.mimeType, body.size,
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

export function updateAssetMetadata(id: string, body: { alt?: string; title?: string; width?: number; height?: number }, actor?: RequestActor | null) {
  return Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;

    const rows = yield* sql.unsafe<AssetRow>("SELECT * FROM assets WHERE id = ?", [id]);
    if (rows.length === 0) return yield* new NotFoundError({ entity: "Asset", id });

    const alt = body.alt !== undefined ? body.alt : rows[0].alt;
    const title = body.title !== undefined ? body.title : rows[0].title;
    const width = body.width !== undefined ? body.width : rows[0].width;
    const height = body.height !== undefined ? body.height : rows[0].height;

    const now = new Date().toISOString();
    yield* sql.unsafe(
      "UPDATE assets SET alt = ?, title = ?, width = ?, height = ?, updated_at = ?, updated_by = ? WHERE id = ?",
      [alt, title, width, height, now, actor?.label ?? null, id]
    );

    return { id, alt, title, width, height, updatedAt: now, updatedBy: actor?.label ?? null };
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
    const { response, resolvedUrl } = yield* fetchRemoteAsset(url, fetch);
    const filename = inferFilename({ ...input, url: resolvedUrl.toString() });
    const id = input.id ?? generateId();
    if (!response.ok) {
      return yield* new ValidationError({
        message: `Failed to fetch asset URL: ${resolvedUrl} (${response.status})`,
      });
    }

    const mimeType = input.mimeType ?? response.headers.get("content-type")?.split(";")[0] ?? "application/octet-stream";
    const bytes = yield* readResponseBytes(response, resolvedUrl.toString());
    const r2Key = input.r2Key ?? `uploads/${id}/${filename}`;

    yield* Effect.tryPromise({
      try: () => r2Bucket.put(r2Key, bytes, { httpMetadata: { contentType: mimeType } }),
      catch: () => new ValidationError({ message: `Failed to store asset in R2: ${filename}` }),
    });

    const dimensions = detectImageDimensions(bytes, mimeType);

    return yield* createAsset({
      id,
      filename,
      mimeType,
      size: bytes.byteLength,
      width: input.width ?? dimensions?.width,
      height: input.height ?? dimensions?.height,
      alt: input.alt,
      title: input.title,
      tags: input.tags,
      blurhash: input.blurhash,
      colors: input.colors,
      focalPoint: input.focalPoint,
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
