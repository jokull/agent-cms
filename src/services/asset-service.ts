import { isObjectRecord, isString, type DynamicRow, type StoredFieldValue } from "../dynamic/row-types.js";
import { DateTime, Context, Effect } from "effect";

import { contentTableName } from "../dynamic/tables.js";
import { SqlClient } from "effect/unstable/sql";
import { generateId } from "../id.js";
import { NotFoundError, ValidationError, ReferenceConflictError } from "../errors.js";
import type { AssetRow, ModelRow } from "../db/row-types.js";
import type { CreateAssetInput, CreateUploadUrlInput, ImportAssetFromUrlInput } from "./input-schemas.js";
import { encodeJson, decodeJsonIfString } from "../json.js";

import {
  assetUrlResolver,
  parseMediaFieldReference,
  parseMediaGalleryReferences,
  withAssetUrl,
  withAssetUrls,
} from "../media-field.js";
export {
  AssetUrlContext,
  resolveAssetUrl,
  withAssetUrl,
  withAssetUrls,
  type AssetUrlConfig,
  type AssetRowWithUrl,
} from "../media-field.js";
import type { RequestActor } from "../attribution.js";
import { likeContains } from "../sql-util.js";

export class AssetImportContext extends Context.Service<
  AssetImportContext,
  {
    readonly r2Bucket: R2Bucket | undefined;
    readonly r2Credentials: R2UploadCredentials | undefined;
    readonly fetch: typeof globalThis.fetch;
  }
>()("AssetImportContext") {}

export interface R2UploadCredentials {
  accessKeyId: string;
  secretAccessKey: string;
  bucketName: string;
  accountId: string;
}

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
  const mimeSubtype = mimeType.split("/")[1] ?? "bin";
  return mimeSubtype.toLowerCase();
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

const fetchRemoteAsset = Effect.fn("fetchRemoteAsset")(function* (url: URL, fetchFn: typeof globalThis.fetch) {
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

const readResponseBytes = Effect.fn("readResponseBytes")(function* (response: Response, url: string) {
  const contentLength = parseContentLength(response.headers.get("content-length"));
  if (contentLength !== null && contentLength > MAX_REMOTE_ASSET_BYTES) {
    return yield* new ValidationError({
      message: `Asset URL is too large to import (${contentLength} bytes > ${MAX_REMOTE_ASSET_BYTES} byte limit)`,
    });
  }

  if (!response.body) {
    return new Uint8Array();
  }

  // SAFETY: fetch response bodies are byte streams; the DOM ReadableStream
  // default type param erases the chunk type, but Workers bodies yield Uint8Array.
  const reader = response.body.getReader() as ReadableStreamDefaultReader<Uint8Array>;
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

    const now = DateTime.formatIso(yield* DateTime.now);
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

    const r2Key = body.r2Key ?? `uploads/${id}/${body.filename}`;
    const resolveUrl = yield* assetUrlResolver;

    return {
      id,
      filename: body.filename,
      mimeType: body.mimeType,
      size: body.size,
      width: body.width,
      height: body.height,
      alt: body.alt,
      title: body.title,
      r2Key,
      url: resolveUrl({ id, filename: body.filename, r2_key: r2Key }),
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

/** Columns `listAssets`'s `orderBy` may sort on (`'<field>_ASC' | '<field>_DESC'`, same
 * convention as `record-service.ts`'s `assertOrderByColumns`). */
const ASSET_ORDER_BY_COLUMNS: ReadonlySet<string> = new Set(["created_at", "updated_at", "filename", "size"]);

const compileAssetOrderBy = Effect.fn("compileAssetOrderBy")(function* (orderBy: readonly string[] | undefined) {
  if (!orderBy || orderBy.length === 0) {
    return `"created_at" DESC`;
  }
  const clauses: string[] = [];
  for (const spec of orderBy) {
    const match = spec.match(/^(.+)_(ASC|DESC)$/);
    if (!match) {
      return yield* new ValidationError({ message: `Invalid orderBy spec '${spec}' (expected '<field>_ASC' or '<field>_DESC')` });
    }
    const [, field, direction] = match;
    if (!ASSET_ORDER_BY_COLUMNS.has(field)) {
      return yield* new ValidationError({ message: `Unknown asset orderBy field '${field}'` });
    }
    clauses.push(`"${field}" ${direction}`);
  }
  return clauses.join(", ");
});

export interface ListAssetsOptions {
  readonly query?: string;
  readonly page?: { readonly limit?: number; readonly offset?: number };
  readonly orderBy?: readonly string[];
}

/**
 * List/search assets with case-insensitive matching against filename, title,
 * and alt text, pagination (with a total count), and column-based ordering.
 */
export function listAssets(opts?: ListAssetsOptions) {
  return Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const query = opts?.query;
    const limit = opts?.page?.limit ?? 24;
    const offset = opts?.page?.offset ?? 0;
    const orderByClause = yield* compileAssetOrderBy(opts?.orderBy);

    const whereClause = query
      ? `WHERE lower(filename) LIKE lower(?) ESCAPE '\\' OR lower(alt) LIKE lower(?) ESCAPE '\\' OR lower(title) LIKE lower(?) ESCAPE '\\'`
      : "";
    const likePattern = query ? likeContains(query) : "";
    const whereParams = query ? [likePattern, likePattern, likePattern] : [];

    const assets = yield* sql.unsafe<AssetRow>(
      `SELECT * FROM assets ${whereClause} ORDER BY ${orderByClause} LIMIT ? OFFSET ?`,
      [...whereParams, limit, offset]
    );
    const countRows = yield* sql.unsafe<{ total: number }>(
      `SELECT COUNT(*) as total FROM assets ${whereClause}`,
      whereParams
    );
    return { assets: yield* withAssetUrls(assets), total: countRows[0]?.total ?? 0 };
  }).pipe(
    Effect.withSpan("asset.list"),
    Effect.annotateSpans({ query: opts?.query ?? "" }),
  );
}

export const getAsset = Effect.fn("getAsset")(function* (id: string) {
  const sql = yield* SqlClient.SqlClient;
  const rows = yield* sql.unsafe<AssetRow>("SELECT * FROM assets WHERE id = ?", [id]);
  if (rows.length === 0) return yield* new NotFoundError({ entity: "Asset", id });
  return yield* withAssetUrl(rows[0]);
});

/**
 * Replace an asset's file while keeping the same ID and URL.
 * Updates metadata (filename, mimeType, size, dimensions, r2Key) but the asset ID
 * and all content references remain stable. DatoCMS can't do this (imgix regenerates URLs).
 */
export const replaceAsset = Effect.fn("replaceAsset")(function* (id: string, body: CreateAssetInput, actor?: RequestActor | null) {
  const sql = yield* SqlClient.SqlClient;

  const rows = yield* sql.unsafe<AssetRow>("SELECT * FROM assets WHERE id = ?", [id]);
  if (rows.length === 0) return yield* new NotFoundError({ entity: "Asset", id });

  const r2Key = body.r2Key ?? `uploads/${id}/${body.filename}`;

  const now = DateTime.formatIso(yield* DateTime.now);
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

  const resolveUrl = yield* assetUrlResolver;

  return {
    id, filename: body.filename, mimeType: body.mimeType, size: body.size,
    width: body.width, height: body.height,
    alt: body.alt ?? rows[0].alt, title: body.title ?? rows[0].title,
    r2Key, url: resolveUrl({ id, filename: body.filename, r2_key: r2Key }),
    replaced: true, updatedAt: now, updatedBy: actor?.label ?? null,
  };
});

export const updateAssetMetadata = Effect.fn("updateAssetMetadata")(function* (id: string, body: { alt?: string; title?: string; width?: number; height?: number }, actor?: RequestActor | null) {
  const sql = yield* SqlClient.SqlClient;

  const rows = yield* sql.unsafe<AssetRow>("SELECT * FROM assets WHERE id = ?", [id]);
  if (rows.length === 0) return yield* new NotFoundError({ entity: "Asset", id });

  const alt = body.alt !== undefined ? body.alt : rows[0].alt;
  const title = body.title !== undefined ? body.title : rows[0].title;
  const width = body.width !== undefined ? body.width : rows[0].width;
  const height = body.height !== undefined ? body.height : rows[0].height;

  const now = DateTime.formatIso(yield* DateTime.now);
  yield* sql.unsafe(
    "UPDATE assets SET alt = ?, title = ?, width = ?, height = ?, updated_at = ?, updated_by = ? WHERE id = ?",
    [alt, title, width, height, now, actor?.label ?? null, id]
  );

  const resolveUrl = yield* assetUrlResolver;

  return {
    id, alt, title, width, height,
    url: resolveUrl({ id, filename: rows[0].filename, r2_key: rows[0].r2_key }),
    updatedAt: now,
    updatedBy: actor?.label ?? null,
  };
});

/**
 * Delete an asset. Guarded by the SAME `getAssetUsages` scan the `/usages`
 * endpoint exposes (single source of truth — the guard and the report can't
 * drift): if any record still references the asset, deletion fails with a
 * `ReferenceConflictError` (HTTP 409) listing each reference as
 * `"<modelApiKey>.<fieldApiKey> (<recordId>)"`. Pass `force` to delete anyway
 * (leaving those references dangling). `getAssetUsages` also raises `NotFound`
 * when the asset does not exist, so no separate existence check is needed.
 */
export function deleteAsset(id: string, force = false) {
  return Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const usages = yield* getAssetUsages(id);
    if (usages.length > 0 && !force) {
      return yield* new ReferenceConflictError({
        message: `Asset '${id}' is referenced by ${usages.length} field value(s) and cannot be deleted. Pass force=true to delete anyway.`,
        references: usages.map((usage) => `${usage.modelApiKey}.${usage.fieldApiKey} (${usage.recordId})`),
      });
    }
    yield* sql.unsafe("DELETE FROM assets WHERE id = ?", [id]);
    return { deleted: true };
  }).pipe(
    Effect.withSpan("asset.delete"),
    Effect.annotateSpans({ assetId: id, force: String(force) }),
  );
}

export interface AssetUsage {
  readonly modelApiKey: string;
  readonly recordId: string;
  readonly fieldApiKey: string;
}

interface AssetReferencingField {
  readonly api_key: string;
  readonly field_type: string;
}

/**
 * Extract asset ids referenced by a single media / media_gallery / seo field's raw
 * column value. None of these three field types are localizable (see
 * `field-types.ts`'s `localizable: false`), so the raw column is always the plain
 * (non-locale-keyed) value — no locale-map unwrapping needed.
 */
function extractAssetIds(fieldType: string, rawValue: StoredFieldValue): string[] {
  const value = decodeJsonIfString(rawValue);
  if (fieldType === "media") {
    const ref = parseMediaFieldReference(value);
    return ref ? [ref.uploadId] : [];
  }
  if (fieldType === "media_gallery") {
    return parseMediaGalleryReferences(value).map((ref) => ref.uploadId);
  }
  if (fieldType === "seo" && isObjectRecord(value) && isString(value.image) && value.image.length > 0) {
    return [value.image];
  }
  return [];
}

/**
 * Which records reference a given asset, via its media / media_gallery / seo.image
 * fields. Uses the same `parseMediaFieldReference` / `parseMediaGalleryReferences`
 * primitives from `../media-field.js` that `record-service.ts` and the GraphQL
 * resolvers use for the same string-or-{upload_id} encoding, so the two can't drift.
 *
 * Scans two layers:
 *  - Every content model's own table (`content_<api_key>`) for top-level
 *    media/media_gallery/seo fields — reported directly as
 *    `{ modelApiKey: <model>, recordId: <row id>, fieldApiKey }`.
 *  - Every block model's table (`block_<api_key>`) for the same field types.
 *    Blocks (including blocks nested inside other blocks, e.g. structured_text
 *    block/inlineBlock payloads) are stored as real SQL rows, not embedded JSON —
 *    each carries `_root_record_id` / `_root_field_api_key` columns pointing back
 *    to the top-level record/field it's attached under (regardless of nesting
 *    depth), so block-table columns ARE reachable the same way as content-table
 *    columns. Usages found there are reported against the *root* record/field
 *    (the model-and-field an editor would actually open to see/remove the
 *    reference), after resolving which content model owns that root record id.
 *
 * NOT covered: an asset id embedded ad hoc inside a JSON/rich-content field's
 * raw value that isn't itself typed media/media_gallery/seo (e.g. a `json`
 * field that happens to contain `{"assetId": "..."}`, or an inline reference
 * baked into a structured_text DAST node's custom attrs) — only the three
 * asset-typed fields are matched.
 */
export function getAssetUsages(id: string) {
  return Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;

    const found = yield* sql.unsafe<{ id: string }>("SELECT id FROM assets WHERE id = ?", [id]);
    if (found.length === 0) return yield* new NotFoundError({ entity: "Asset", id });

    const models = yield* sql.unsafe<ModelRow>("SELECT * FROM models");
    const contentModels = models.filter((m) => m.is_block === 0);

    const rootModelCache = new Map<string, string | null>();
    const resolveRootModel = (recordId: string) => Effect.gen(function* () {
      const cached = rootModelCache.get(recordId);
      if (cached !== undefined) return cached;
      for (const contentModel of contentModels) {
        const rows = yield* sql.unsafe<{ id: string }>(
          `SELECT id FROM "${contentTableName(contentModel.api_key)}" WHERE id = ?`,
          [recordId],
        );
        if (rows.length > 0) {
          rootModelCache.set(recordId, contentModel.api_key);
          return contentModel.api_key;
        }
      }
      rootModelCache.set(recordId, null);
      return null;
    });

    const usages: AssetUsage[] = [];

    for (const model of models) {
      const fields = yield* sql.unsafe<AssetReferencingField>(
        "SELECT api_key, field_type FROM fields WHERE model_id = ? AND field_type IN ('media', 'media_gallery', 'seo')",
        [model.id],
      );
      if (fields.length === 0) continue;

      const isBlock = model.is_block === 1;
      const tableName = isBlock ? `block_${model.api_key}` : contentTableName(model.api_key);
      const rootColumns = isBlock ? `, "_root_record_id", "_root_field_api_key"` : "";
      const rows = yield* sql.unsafe<DynamicRow>(
        `SELECT "id"${rootColumns}, ${fields.map((f) => `"${f.api_key}"`).join(", ")} FROM "${tableName}"`
      );

      for (const row of rows) {
        for (const field of fields) {
          // SAFETY: content/block table cells are StoredFieldValue by the dynamic-zone contract.
          const assetIds = extractAssetIds(field.field_type, row[field.api_key] as StoredFieldValue);
          if (!assetIds.includes(id)) continue;

          if (isBlock) {
            const rootRecordId = isString(row._root_record_id) ? row._root_record_id : null;
            const rootFieldApiKey = isString(row._root_field_api_key) ? row._root_field_api_key : null;
            if (!rootRecordId || !rootFieldApiKey) continue;
            const rootModelApiKey = yield* resolveRootModel(rootRecordId);
            if (!rootModelApiKey) continue;
            usages.push({ modelApiKey: rootModelApiKey, recordId: rootRecordId, fieldApiKey: rootFieldApiKey });
          } else {
            usages.push({ modelApiKey: model.api_key, recordId: String(row.id), fieldApiKey: field.api_key });
          }
        }
      }
    }

    const seen = new Set<string>();
    return usages.filter((usage) => {
      const key = `${usage.modelApiKey} ${usage.recordId} ${usage.fieldApiKey}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
  }).pipe(
    Effect.withSpan("asset.usages"),
    Effect.annotateSpans({ assetId: id }),
  );
}

export const createAssetUploadUrl = Effect.fn("createAssetUploadUrl")(function* (input: CreateUploadUrlInput) {
  const { r2Credentials } = yield* AssetImportContext;
  if (!r2Credentials) {
    return yield* new ValidationError({ message: "Presigned uploads not configured" });
  }

  const { S3Client, PutObjectCommand } = yield* Effect.tryPromise({
    try: () => import("@aws-sdk/client-s3"),
    catch: () => new ValidationError({ message: "Failed to load R2 signing client" }),
  });
  const { getSignedUrl } = yield* Effect.tryPromise({
    try: () => import("@aws-sdk/s3-request-presigner"),
    catch: () => new ValidationError({ message: "Failed to load R2 signing helper" }),
  });

  const assetId = crypto.randomUUID();
  const r2Key = `uploads/${assetId}/${input.filename}`;
  const s3 = new S3Client({
    region: "auto",
    endpoint: `https://${r2Credentials.accountId}.r2.cloudflarestorage.com`,
    credentials: {
      accessKeyId: r2Credentials.accessKeyId,
      secretAccessKey: r2Credentials.secretAccessKey,
    },
  });
  const command = new PutObjectCommand({
    Bucket: r2Credentials.bucketName,
    Key: r2Key,
    ContentType: input.mimeType,
  });
  const uploadUrl = yield* Effect.tryPromise({
    try: () => getSignedUrl(s3, command, { expiresIn: 3600 }),
    catch: () => new ValidationError({ message: "Failed to create R2 upload URL" }),
  });

  return { uploadUrl, r2Key, assetId };
});

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
