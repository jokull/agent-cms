/**
 * Canonical asset URLs (BUILDOUT 4 / G1).
 *
 * Every asset row and every media / media_gallery / seo value a read returns
 * carries a URL — resolved from ASSET_BASE_URL, else from the request origin
 * against the CMS's own /assets/:id/:filename route. And it costs ONE extra
 * query per read, not one per field.
 */
import { describe, it, expect, beforeEach } from "vitest";
import { Effect, Layer } from "effect";
import { SqlClient } from "@effect/sql";
import { createTestApp, jsonRequest } from "./app-helpers.js";
import * as RecordService from "../src/services/record-service.js";
import { AssetUrlContext, resolveAssetUrl } from "../src/media-field.js";

interface Seeded {
  handler: (req: Request) => Promise<Response>;
  sqlLayer: Layer.Layer<SqlClient.SqlClient>;
  assetIds: string[];
  recordIds: string[];
}

async function seed(options?: { assetBaseUrl?: string; records?: number }): Promise<Seeded> {
  const { handler, sqlLayer } = createTestApp(
    options?.assetBaseUrl === undefined ? undefined : { assetBaseUrl: options.assetBaseUrl },
  );

  const model = await (await jsonRequest(handler, "POST", "/api/models", { name: "Page", apiKey: "page" })).json();
  for (const field of [
    { label: "Cover", apiKey: "cover", fieldType: "media" },
    { label: "Gallery", apiKey: "gallery", fieldType: "media_gallery" },
    { label: "Seo", apiKey: "seo_field", fieldType: "seo" },
  ]) {
    const res = await jsonRequest(handler, "POST", `/api/models/${model.id}/fields`, field);
    expect(res.status).toBe(201);
  }

  const assetIds: string[] = [];
  for (const filename of ["one.png", "two png with space.png", "three.png"]) {
    const res = await jsonRequest(handler, "POST", "/api/assets", {
      filename,
      mimeType: "image/png",
      size: 1234,
      width: 100,
      height: 50,
      alt: `alt for ${filename}`,
    });
    expect(res.status).toBe(201);
    assetIds.push((await res.json()).id);
  }

  const recordIds: string[] = [];
  for (let index = 0; index < (options?.records ?? 1); index += 1) {
    const res = await jsonRequest(handler, "POST", "/api/records", {
      modelApiKey: "page",
      data: {
        cover: assetIds[0],
        gallery: [assetIds[1], assetIds[2]],
        seo_field: { title: "t", image: assetIds[2] },
      },
    });
    expect(res.status).toBe(201);
    recordIds.push((await res.json()).id);
  }

  return { handler, sqlLayer, assetIds, recordIds };
}

describe("asset URL resolution order", () => {
  it("uses ASSET_BASE_URL + r2_key when a base URL is configured", () => {
    const url = resolveAssetUrl(
      { id: "a1", filename: "x.png", r2_key: "uploads/a1/x.png" },
      { baseUrl: "https://cdn.example.com/" },
    );
    expect(url).toBe("https://cdn.example.com/uploads/a1/x.png");
  });

  it("falls back to <origin>/assets/:id/:filename when only an origin is known", () => {
    const url = resolveAssetUrl(
      { id: "a1", filename: "my file.png", r2_key: "uploads/a1/my file.png" },
      { origin: "https://cms.example.com" },
    );
    expect(url).toBe("https://cms.example.com/assets/a1/my%20file.png");
  });

  it("falls back to a same-origin relative path when nothing is configured", () => {
    const url = resolveAssetUrl({ id: "a1", filename: "x.png", r2_key: "uploads/a1/x.png" }, {});
    expect(url).toBe("/assets/a1/x.png");
  });
});

describe("asset reads carry a url", () => {
  it("GET /api/assets and /api/assets/:id return an absolute url from ASSET_BASE_URL", async () => {
    const { handler, assetIds } = await seed({ assetBaseUrl: "https://cdn.example.com" });

    const list = await (await jsonRequest(handler, "GET", "/api/assets")).json();
    expect(list.assets.length).toBe(3);
    for (const asset of list.assets) {
      expect(asset.url).toBe(`https://cdn.example.com/${asset.r2_key}`);
    }

    const one = await (await jsonRequest(handler, "GET", `/api/assets/${assetIds[0]}`)).json();
    expect(one.url).toBe(`https://cdn.example.com/${one.r2_key}`);
  });

  it("falls back to the CMS's own /assets route (request origin) with no ASSET_BASE_URL", async () => {
    const { handler, assetIds } = await seed();

    const one = await (await jsonRequest(handler, "GET", `/api/assets/${assetIds[0]}`)).json();
    expect(one.url).toBe(`http://localhost/assets/${assetIds[0]}/one.png`);
    expect(one.url.startsWith("http://")).toBe(true);
  });

  it("carries a url on create / replace / metadata-update results too", async () => {
    const { handler, assetIds } = await seed({ assetBaseUrl: "https://cdn.example.com" });

    const created = await (await jsonRequest(handler, "POST", "/api/assets", {
      filename: "new.png",
      mimeType: "image/png",
      size: 1,
    })).json();
    expect(created.url).toBe(`https://cdn.example.com/${created.r2Key}`);

    const updated = await (await jsonRequest(handler, "PATCH", `/api/assets/${assetIds[0]}`, {
      alt: "changed",
    })).json();
    expect(updated.url).toBe(`https://cdn.example.com/uploads/${assetIds[0]}/one.png`);
  });
});

describe("record reads carry media urls", () => {
  it("enriches media, media_gallery and seo.image", async () => {
    const { handler, assetIds, recordIds } = await seed({ assetBaseUrl: "https://cdn.example.com" });

    const record = await (await jsonRequest(handler, "GET", `/api/records/${recordIds[0]}?modelApiKey=page`)).json();

    expect(record.cover.upload_id).toBe(assetIds[0]);
    expect(record.cover.url).toBe(`https://cdn.example.com/uploads/${assetIds[0]}/one.png`);
    expect(record.cover.filename).toBe("one.png");
    expect(record.cover.width).toBe(100);
    expect(record.cover.alt).toBe("alt for one.png");

    expect(record.gallery).toHaveLength(2);
    expect(record.gallery[0].upload_id).toBe(assetIds[1]);
    expect(record.gallery[0].url).toContain("two%20png%20with%20space.png".replace(/%20/g, " "));
    expect(record.gallery[1].url).toBe(`https://cdn.example.com/uploads/${assetIds[2]}/three.png`);

    // seo keeps `image` as the asset id (write vocabulary) and adds image_url.
    expect(record.seo_field.image).toBe(assetIds[2]);
    expect(record.seo_field.image_url).toBe(`https://cdn.example.com/uploads/${assetIds[2]}/three.png`);
  });

  it("leaves a dangling reference untouched instead of inventing a url", async () => {
    const { handler, sqlLayer, recordIds } = await seed({ assetBaseUrl: "https://cdn.example.com" });
    // Bypass write validation: point the stored column at a deleted asset.
    await Effect.runPromise(
      Effect.flatMap(SqlClient.SqlClient, (sql) =>
        sql.unsafe(`UPDATE "content_page" SET "cover" = ? WHERE id = ?`, ["missing-asset", recordIds[0]]),
      ).pipe(Effect.provide(sqlLayer), Effect.orDie),
    );

    const record = await (await jsonRequest(handler, "GET", `/api/records/${recordIds[0]}?modelApiKey=page`)).json();
    expect(record.cover).toBe("missing-asset");
  });

  it("read-modify-write round-trips: enrichment keys are stripped on write", async () => {
    const { handler, sqlLayer, assetIds, recordIds } = await seed({ assetBaseUrl: "https://cdn.example.com" });

    const record = await (await jsonRequest(handler, "GET", `/api/records/${recordIds[0]}?modelApiKey=page`)).json();
    const written = await jsonRequest(handler, "PATCH", `/api/records/${recordIds[0]}?modelApiKey=page`, {
      modelApiKey: "page",
      data: { cover: record.cover, gallery: record.gallery, seo_field: record.seo_field },
    });
    expect(written.status).toBe(200);

    const stored = await (await jsonRequest(handler, "GET", `/api/records/${recordIds[0]}?modelApiKey=page`)).json();
    expect(stored.cover.upload_id).toBe(assetIds[0]);
    expect(stored.cover.url).toBe(record.cover.url);

    // What is actually PERSISTED holds no resolved metadata — only the reference.
    const rows = await Effect.runPromise(
      Effect.flatMap(SqlClient.SqlClient, (sql) =>
        sql.unsafe<{ cover: string; gallery: string; seo_field: string }>(
          `SELECT "cover", "gallery", "seo_field" FROM "content_page" WHERE id = ?`,
          [recordIds[0]],
        ),
      ).pipe(Effect.provide(sqlLayer), Effect.orDie),
    );
    expect(rows[0].cover).not.toContain("cdn.example.com");
    expect(rows[0].cover).not.toContain("filename");
    expect(rows[0].gallery).not.toContain("cdn.example.com");
    expect(rows[0].seo_field).not.toContain("image_url");
  });

  it("picker rows carry the preview asset's url", async () => {
    const { handler, recordIds } = await seed({ assetBaseUrl: "https://cdn.example.com" });
    expect(recordIds).toHaveLength(1);
    const rows = await (await jsonRequest(handler, "GET", "/api/records/picker-search?modelApiKey=page&q=")).json();
    expect(Array.isArray(rows)).toBe(true);
    expect(rows).toHaveLength(1);
    expect(rows[0].image).toBeTruthy();
    expect(rows[0].imageUrl).toBe(`https://cdn.example.com/uploads/${rows[0].image}/one.png`);
  });
});

/** Wrap a SqlClient layer so every `unsafe` statement is recorded. */
function countingLayer(base: Layer.Layer<SqlClient.SqlClient>, statements: string[]) {
  return Layer.effect(
    SqlClient.SqlClient,
    Effect.map(SqlClient.SqlClient, (sql) =>
      new Proxy(sql, {
        get(target, property, receiver) {
          if (property === "unsafe") {
            return (query: string, params?: ReadonlyArray<unknown>) => {
              statements.push(query);
              return target.unsafe(query, params);
            };
          }
          return Reflect.get(target, property, receiver);
        },
      }),
    ),
  ).pipe(Layer.provide(base));
}

describe("media enrichment does not introduce an N+1", () => {
  const assetQueries = (statements: readonly string[]) =>
    statements.filter((statement) => /FROM assets WHERE id IN/i.test(statement));

  it("resolves a whole record set with exactly one batched asset query", async () => {
    const { sqlLayer, recordIds } = await seed({ assetBaseUrl: "https://cdn.example.com", records: 4 });
    expect(recordIds).toHaveLength(4);

    const statements: string[] = [];
    const page = await Effect.runPromise(
      RecordService.queryRecords("page", {}).pipe(
        Effect.provide(
          Layer.merge(
            countingLayer(sqlLayer, statements),
            Layer.succeed(AssetUrlContext, { current: () => ({ baseUrl: "https://cdn.example.com" }) }),
          ),
        ),
        Effect.orDie,
      ),
    );

    expect(page.records).toHaveLength(4);
    for (const record of page.records) {
      expect(String(Reflect.get(Object(record.cover), "url"))).toContain("https://cdn.example.com/");
    }
    // 4 records × 3 asset-typed fields would be 12 lookups without batching.
    expect(assetQueries(statements)).toHaveLength(1);
  });

  it("costs the same one query for a single record", async () => {
    const { sqlLayer, recordIds } = await seed({ assetBaseUrl: "https://cdn.example.com" });

    const statements: string[] = [];
    await Effect.runPromise(
      RecordService.getRecord("page", recordIds[0]).pipe(
        Effect.provide(
          Layer.merge(
            countingLayer(sqlLayer, statements),
            Layer.succeed(AssetUrlContext, { current: () => ({ baseUrl: "https://cdn.example.com" }) }),
          ),
        ),
        Effect.orDie,
      ),
    );

    expect(assetQueries(statements)).toHaveLength(1);
  });
});

describe("media inside structured_text block payloads", () => {
  it("enriches a block payload's media field, still with one batched query", async () => {
    const { handler, sqlLayer } = createTestApp({ assetBaseUrl: "https://cdn.example.com" });

    const blockModel = await (await jsonRequest(handler, "POST", "/api/models", {
      name: "Figure", apiKey: "figure", isBlock: true,
    })).json();
    await jsonRequest(handler, "POST", `/api/models/${blockModel.id}/fields`, {
      label: "Image", apiKey: "image", fieldType: "media",
    });

    const article = await (await jsonRequest(handler, "POST", "/api/models", {
      name: "Article", apiKey: "article",
    })).json();
    await jsonRequest(handler, "POST", `/api/models/${article.id}/fields`, {
      label: "Body", apiKey: "body", fieldType: "structured_text",
      validators: { structured_text_blocks: ["figure"] },
    });
    await jsonRequest(handler, "POST", `/api/models/${article.id}/fields`, {
      label: "Cover", apiKey: "cover", fieldType: "media",
    });

    const asset = await (await jsonRequest(handler, "POST", "/api/assets", {
      filename: "fig.png", mimeType: "image/png", size: 10, width: 20, height: 10,
    })).json();

    const created = await jsonRequest(handler, "POST", "/api/records", {
      modelApiKey: "article",
      data: {
        cover: asset.id,
        body: {
          value: {
            schema: "dast",
            document: { type: "root", children: [{ type: "block", item: "fig1" }] },
          },
          blocks: { fig1: { _type: "figure", image: asset.id } },
        },
      },
    });
    expect(created.status).toBe(201);
    const recordId = (await created.json()).id;

    const statements: string[] = [];
    const record = await Effect.runPromise(
      RecordService.getRecord("article", recordId).pipe(
        Effect.provide(
          Layer.merge(
            countingLayer(sqlLayer, statements),
            Layer.succeed(AssetUrlContext, { current: () => ({ baseUrl: "https://cdn.example.com" }) }),
          ),
        ),
        Effect.orDie,
      ),
    );

    const body = Object(Reflect.get(Object(record), "body"));
    const blocks = Object(Reflect.get(body, "blocks"));
    const figure = Object(Object.values(blocks)[0]);
    const image = Object(Reflect.get(figure, "image"));
    expect(Reflect.get(image, "upload_id")).toBe(asset.id);
    expect(Reflect.get(image, "url")).toBe(`https://cdn.example.com/uploads/${asset.id}/fig.png`);

    // The block's media and the record's own media resolve together.
    expect(statements.filter((s) => /FROM assets WHERE id IN/i.test(s))).toHaveLength(1);
  });
});
