/**
 * Wave 11 gate: the schema-driven boundary decode must be byte-identical to
 * `deserializeRecord`'s string-prefix sniffing on a corpus of realistic
 * content-table rows — all field-type shapes, legacy forms, and malformed
 * data — while additionally validating where the shape is known.
 */
import { describe, expect, it } from "vitest";
import { Exit, Schema } from "effect";
import { buildModelRowSchema, tolerantJsonField, fieldDecodeSchema, validatingFieldDecodeSchema } from "../src/dynamic/row-schema.js";
import { deserializeRecord } from "../src/dynamic/decode.js";
import type { ParsedFieldRow } from "../src/db/row-types.js";

const FIELDS: ParsedFieldRow[] = [
  { api_key: "title", field_type: "string" } as ParsedFieldRow,
  { api_key: "body", field_type: "text" } as ParsedFieldRow,
  { api_key: "published", field_type: "boolean" } as ParsedFieldRow,
  { api_key: "count", field_type: "integer" } as ParsedFieldRow,
  { api_key: "rating", field_type: "float" } as ParsedFieldRow,
  { api_key: "slug", field_type: "slug" } as ParsedFieldRow,
  { api_key: "release", field_type: "date" } as ParsedFieldRow,
  { api_key: "released_at", field_type: "date_time" } as ParsedFieldRow,
  { api_key: "cover", field_type: "media" } as ParsedFieldRow,
  { api_key: "gallery", field_type: "media_gallery" } as ParsedFieldRow,
  { api_key: "author", field_type: "link" } as ParsedFieldRow,
  { api_key: "tags", field_type: "links" } as ParsedFieldRow,
  { api_key: "dast", field_type: "structured_text" } as ParsedFieldRow,
  { api_key: "seo", field_type: "seo" } as ParsedFieldRow,
  { api_key: "extra", field_type: "json" } as ParsedFieldRow,
  { api_key: "palette", field_type: "color" } as ParsedFieldRow,
  { api_key: "location", field_type: "lat_lon" } as ParsedFieldRow,
  { api_key: "video", field_type: "video" } as ParsedFieldRow,
];

const SYSTEM_ROW = {
  id: "rec_1",
  _status: "published",
  _published_at: "2026-08-15T10:00:00.000Z",
  _first_published_at: "2026-08-01T10:00:00.000Z",
  _published_snapshot: JSON.stringify({ title: "Old" }),
  _created_at: "2026-08-01T09:00:00.000Z",
  _updated_at: "2026-08-15T10:00:00.000Z",
  _created_by: "admin",
  _updated_by: "admin",
  _published_by: "admin",
  _scheduled_publish_at: null,
  _scheduled_unpublish_at: null,
};

const ROWS: Array<Record<string, unknown>> = [
  // modern shapes
  {
    ...SYSTEM_ROW,
    title: "Hello",
    body: "Long text",
    published: 1,
    count: 7,
    rating: 4.5,
    slug: "hello",
    release: "2026-08-15",
    released_at: "2026-08-15T10:00:00.000Z",
    cover: JSON.stringify({ upload_id: "a1", alt: "Alt" }),
    gallery: JSON.stringify([{ upload_id: "a1" }, { upload_id: "a2" }]),
    author: "rec_2",
    tags: JSON.stringify(["t1", "t2"]),
    dast: JSON.stringify({ schema: "dast", document: { type: "root", children: [] } }),
    seo: JSON.stringify({ title: "SEO" }),
    extra: JSON.stringify({ any: true, n: 1 }),
    palette: JSON.stringify({ red: 1, green: 2, blue: 3 }),
    location: JSON.stringify({ latitude: 64.1, longitude: -21.9 }),
    video: JSON.stringify({ provider: "youtube", provider_uid: "abc", title: "T" }),
  },
  // legacy / tolerant shapes
  {
    ...SYSTEM_ROW,
    title: "Legacy",
    body: null,
    published: true,
    count: null,
    rating: null,
    slug: null,
    release: null,
    released_at: null,
    cover: "legacy-upload-id-string",
    gallery: "not-json-at-all",
    author: null,
    tags: "[1, 2",
    palette: "{invalid json",
    dast: "not-json",
    extra: JSON.stringify([1, 2]),
    video: "https://example.com/v.mp4",
    seo: null,
    location: null,
  },
  // sparse row (nulls everywhere)
  {
    ...SYSTEM_ROW,
    title: null,
    body: null,
    published: 0,
    count: null,
    rating: null,
    slug: null,
    release: null,
    released_at: null,
    cover: null,
    gallery: null,
    author: null,
    tags: null,
    dast: null,
    seo: null,
    extra: null,
    palette: null,
    location: null,
    video: null,
  },
];

function decodeRow(schema: Schema.Schema<Record<string, unknown>>, row: Record<string, unknown>) {
  const exit = Schema.decodeUnknownExit(schema)(row);
  if (Exit.isFailure(exit)) throw new Error(`decode failed: ${String(exit.cause)}`);
  return exit.value;
}

describe("schema-driven boundary decode", () => {
  const schema = buildModelRowSchema(FIELDS);

  it("is byte-identical to deserializeRecord on the corpus", () => {
    for (const [i, row] of ROWS.entries()) {
      const tolerant = deserializeRecord(row);
      try {
        const decoded = decodeRow(schema, row);
        expect(decoded).toEqual(tolerant);
      } catch (e) {
        console.log("row index", i, "keys:", Object.keys(row).length);
        throw e;
      }
    }
  });

  it("preserves system columns and unknown-free rows", () => {
    const decoded = decodeRow(schema, ROWS[0]);
    expect(decoded.id).toBe("rec_1");
    expect(decoded._status).toBe("published");
    expect(Object.keys(decoded).sort()).toEqual(Object.keys(ROWS[0]).sort());
  });

  it("validating form parses known shapes, string-falls-back on wrong shape", () => {
    const s = validatingFieldDecodeSchema("color");
    const good = Schema.decodeUnknownExit(s!)(JSON.stringify({ red: 1, green: 2, blue: 3 }));
    expect(Exit.isSuccess(good)).toBe(true);
    // wrong-shape JSON: falls back to the raw string (tolerant, never row failure)
    const bad = Schema.decodeUnknownExit(s!)(JSON.stringify({ red: "x" }));
    expect(Exit.isSuccess(bad)).toBe(true);
    if (Exit.isSuccess(bad)) expect(bad.value).toBe(JSON.stringify({ red: "x" }));
  });

  it("boolean read shape accepts 0/1 and true/false", () => {
    for (const v of [0, 1, true, false, null]) {
      const s = fieldDecodeSchema("boolean");
      expect(Exit.isSuccess(Schema.decodeUnknownExit(s!)(v))).toBe(true);
    }
  });

  it("parses quoted-string JSON that sniffing misses (documented improvement)", () => {
    const s = tolerantJsonField(Schema.Unknown);
    const raw = JSON.stringify("t1"); // ""t1"" — valid JSON, sniffing ignores it
    expect(deserializeRecord({ tags: raw }).tags).toBe(raw);        // sniffing: raw string
    const decoded = Schema.decodeUnknownExit(s)(raw);
    expect(Exit.isSuccess(decoded)).toBe(true);
    if (Exit.isSuccess(decoded)) expect(decoded.value).toBe("t1");  // schema: parsed
  });

  it("tolerantJsonField is total on arbitrary strings", () => {
    const s = tolerantJsonField(Schema.Unknown);
    for (const v of ["{", "[1,", "null", "123", "hello", "{}", "[]", '"quoted"']) {
      expect(Exit.isSuccess(Schema.decodeUnknownExit(s)(v))).toBe(true);
    }
  });
});
