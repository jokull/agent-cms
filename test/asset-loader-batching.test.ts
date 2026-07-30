/**
 * Asset loading in the Yoga path must not scale with the number of records
 * or blocks that reference an asset (#27).
 *
 * These tests assert SQL *statement counts*, not timings — the whole point of
 * the request-scoped loader is that adding records adds no round trips. Every
 * query here runs with drafts on, which forces the Yoga resolver path
 * (`draft_or_invalid_context`); the published fast path has its own batching
 * and would otherwise mask the thing under test.
 */
import { describe, it, expect } from "vitest";
import { createTestApp, jsonRequest } from "./app-helpers.js";

/** Run a GraphQL query on the Yoga path and report how many SQL statements it took. */
async function countStatements(
  handler: (req: Request) => Promise<Response>,
  query: string,
): Promise<{ statements: number; data: unknown; errors?: unknown }> {
  const res = await handler(
    new Request("http://localhost/graphql", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Include-Drafts": "true",
        // Enables withSqlMetrics + X-Sql-* response headers.
        "X-Bench-Trace": "1",
      },
      body: JSON.stringify({ query }),
    }),
  );
  const header = res.headers.get("X-Sql-Statement-Count");
  expect(header, "X-Bench-Trace should produce a statement count").not.toBeNull();
  const body = await res.json();
  return { statements: Number(header), data: body.data, errors: body.errors };
}

async function createAssets(
  handler: (req: Request) => Promise<Response>,
  count: number,
): Promise<string[]> {
  const ids: string[] = [];
  for (let index = 0; index < count; index += 1) {
    const res = await jsonRequest(handler, "POST", "/api/assets", {
      filename: `asset-${index}.png`,
      mimeType: "image/png",
      size: 100 + index,
      width: 800,
      height: 600,
      alt: `alt ${index}`,
    });
    expect(res.status).toBe(201);
    ids.push((await res.json()).id);
  }
  return ids;
}

describe("asset loader batching — content model fields", () => {
  async function seedPages(recordCount: number) {
    const { handler } = createTestApp();
    const model = await (
      await jsonRequest(handler, "POST", "/api/models", { name: "Page", apiKey: "page" })
    ).json();
    for (const field of [
      { label: "Cover", apiKey: "cover", fieldType: "media" },
      { label: "Gallery", apiKey: "gallery", fieldType: "media_gallery" },
    ]) {
      expect((await jsonRequest(handler, "POST", `/api/models/${model.id}/fields`, field)).status).toBe(201);
    }

    // Distinct assets per record, so nothing batches by accident through the cache.
    const assetIds = await createAssets(handler, recordCount * 3);
    for (let index = 0; index < recordCount; index += 1) {
      const res = await jsonRequest(handler, "POST", "/api/records", {
        modelApiKey: "page",
        data: {
          cover: assetIds[index * 3],
          gallery: [assetIds[index * 3 + 1], assetIds[index * 3 + 2]],
        },
      });
      expect(res.status).toBe(201);
    }
    return handler;
  }

  const QUERY = `{ allPages { id cover { url alt } gallery { url } } }`;

  it("costs the same number of statements for 1 record as for 6", async () => {
    const one = await countStatements(await seedPages(1), QUERY);
    const six = await countStatements(await seedPages(6), QUERY);

    expect(one.errors).toBeUndefined();
    expect(six.errors).toBeUndefined();
    // Sanity: the data is actually there, so we're not counting a no-op.
    expect(six.data).toMatchObject({ allPages: expect.any(Array) });
    expect(six.data.allPages).toHaveLength(6);
    for (const page of six.data.allPages) {
      expect(page.cover.url).toContain(".png");
      expect(page.gallery).toHaveLength(2);
    }

    // The load-bearing assertion: 6x the records, 6x the assets, same SQL.
    expect(six.statements).toBe(one.statements);
  });

  it("fetches an asset once when several fields on several records share it", async () => {
    const { handler } = createTestApp();
    const model = await (
      await jsonRequest(handler, "POST", "/api/models", { name: "Page", apiKey: "page" })
    ).json();
    for (const field of [
      { label: "Cover", apiKey: "cover", fieldType: "media" },
      { label: "Gallery", apiKey: "gallery", fieldType: "media_gallery" },
    ]) {
      expect((await jsonRequest(handler, "POST", `/api/models/${model.id}/fields`, field)).status).toBe(201);
    }

    const [shared] = await createAssets(handler, 1);
    for (let index = 0; index < 5; index += 1) {
      const res = await jsonRequest(handler, "POST", "/api/records", {
        modelApiKey: "page",
        data: { cover: shared, gallery: [shared, shared] },
      });
      expect(res.status).toBe(201);
    }

    const result = await countStatements(handler, QUERY);
    expect(result.errors).toBeUndefined();
    expect(result.data.allPages).toHaveLength(5);

    // 5 records x 3 references to one asset. One root query + one asset query
    // is the floor; allow a small margin for schema/locale bookkeeping but
    // nothing resembling 15 fetches.
    expect(result.statements).toBeLessThanOrEqual(4);
  });
});

describe("asset loader batching — block model fields", () => {
  /**
   * The shape from #26: structured_text -> block -> media. Before the loader
   * this cost one query per block instance with no cache at all.
   */
  async function seedGuide(blockCount: number) {
    const { handler } = createTestApp();
    const venue = await (
      await jsonRequest(handler, "POST", "/api/models", {
        name: "Venue", apiKey: "venue", isBlock: true,
      })
    ).json();
    expect((await jsonRequest(handler, "POST", `/api/models/${venue.id}/fields`, {
      label: "Name", apiKey: "name", fieldType: "string",
    })).status).toBe(201);
    expect((await jsonRequest(handler, "POST", `/api/models/${venue.id}/fields`, {
      label: "Image", apiKey: "image", fieldType: "media",
    })).status).toBe(201);

    const guide = await (
      await jsonRequest(handler, "POST", "/api/models", { name: "Guide", apiKey: "guide" })
    ).json();
    expect((await jsonRequest(handler, "POST", `/api/models/${guide.id}/fields`, {
      label: "Content",
      apiKey: "content",
      fieldType: "structured_text",
      validators: { structured_text_blocks: ["venue"] },
    })).status).toBe(201);

    const assetIds = await createAssets(handler, blockCount);
    const blocks: Record<string, unknown> = {};
    const children: unknown[] = [];
    for (let index = 0; index < blockCount; index += 1) {
      const blockId = `venue_${index}`;
      children.push({ type: "block", item: blockId });
      blocks[blockId] = { _type: "venue", name: `Venue ${index}`, image: assetIds[index] };
    }

    const res = await jsonRequest(handler, "POST", "/api/records", {
      modelApiKey: "guide",
      data: {
        content: {
          value: { schema: "dast", document: { type: "root", children } },
          blocks,
        },
      },
    });
    expect(res.status).toBe(201);
    return handler;
  }

  const QUERY = `{
    allGuides {
      id
      content {
        blocks {
          ... on VenueRecord { id name image { url alt } }
        }
      }
    }
  }`;

  it("costs the same number of statements for 1 block as for 6", async () => {
    const one = await countStatements(await seedGuide(1), QUERY);
    const six = await countStatements(await seedGuide(6), QUERY);

    expect(one.errors).toBeUndefined();
    expect(six.errors).toBeUndefined();
    expect(six.data.allGuides[0].content.blocks).toHaveLength(6);
    for (const block of six.data.allGuides[0].content.blocks) {
      expect(block.image.url).toContain(".png");
      expect(block.image.alt).toContain("alt");
    }

    expect(six.statements).toBe(one.statements);
  });
});
