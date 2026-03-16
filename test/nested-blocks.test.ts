import { describe, it, expect, beforeEach } from "vitest";
import { Effect } from "effect";
import { SqlClient } from "@effect/sql";
import { createTestApp, jsonRequest, gqlQuery } from "./app-helpers.js";

describe("P1.6: Nested blocks", () => {
  let handler: (req: Request) => Promise<Response>;
  let sqlLayer: any;

  beforeEach(async () => {
    ({ handler, sqlLayer } = createTestApp());

    // Inner block type: feature_card
    const cardRes = await jsonRequest(handler, "POST", "/api/models", {
      name: "Feature Card", apiKey: "feature_card", isBlock: true,
    });
    const card = await cardRes.json();
    await jsonRequest(handler, "POST", `/api/models/${card.id}/fields`, {
      label: "Title", apiKey: "title", fieldType: "string",
    });
    await jsonRequest(handler, "POST", `/api/models/${card.id}/fields`, {
      label: "Description", apiKey: "description", fieldType: "text",
    });

    // Outer block type: feature_grid (has ST field containing feature_cards)
    const gridRes = await jsonRequest(handler, "POST", "/api/models", {
      name: "Feature Grid", apiKey: "feature_grid", isBlock: true,
    });
    const grid = await gridRes.json();
    await jsonRequest(handler, "POST", `/api/models/${grid.id}/fields`, {
      label: "Heading", apiKey: "heading", fieldType: "string",
    });
    await jsonRequest(handler, "POST", `/api/models/${grid.id}/fields`, {
      label: "Features", apiKey: "features", fieldType: "structured_text",
      validators: { structured_text_blocks: ["feature_card"], blocks_only: true },
    });

    // Content model: page
    const pageRes = await jsonRequest(handler, "POST", "/api/models", { name: "Page", apiKey: "page" });
    const page = await pageRes.json();
    await jsonRequest(handler, "POST", `/api/models/${page.id}/fields`, {
      label: "Title", apiKey: "title", fieldType: "string",
    });
    await jsonRequest(handler, "POST", `/api/models/${page.id}/fields`, {
      label: "Content", apiKey: "content", fieldType: "structured_text",
      validators: { structured_text_blocks: ["feature_grid"] },
    });
  });

  it("writes nested blocks: page → feature_grid → feature_cards", async () => {
    const gridBlockId = "01HNESTED_GRID_001";
    const card1Id = "01HNESTED_CARD_001";
    const card2Id = "01HNESTED_CARD_002";

    const res = await jsonRequest(handler, "POST", "/api/records", {
      modelApiKey: "page",
      data: {
        title: "Features Page",
        content: {
          value: {
            schema: "dast",
            document: {
              type: "root",
              children: [{ type: "block", item: gridBlockId }],
            },
          },
          blocks: {
            [gridBlockId]: {
              _type: "feature_grid",
              heading: "Our Features",
              features: {
                value: {
                  schema: "dast",
                  document: {
                    type: "root",
                    children: [
                      { type: "block", item: card1Id },
                      { type: "block", item: card2Id },
                    ],
                  },
                },
                blocks: {
                  [card1Id]: { _type: "feature_card", title: "Fast", description: "Lightning speed" },
                  [card2Id]: { _type: "feature_card", title: "Secure", description: "Bank-grade security" },
                },
              },
            },
          },
        },
      },
    });

    expect(res.status).toBe(201);
    const record = await res.json();

    // Verify all blocks were written
    const gridBlocks = await Effect.runPromise(
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        return yield* sql.unsafe<Record<string, any>>(
          'SELECT * FROM "block_feature_grid" WHERE _root_record_id = ?',
          [record.id]
        );
      }).pipe(Effect.provide(sqlLayer))
    );
    expect(gridBlocks).toHaveLength(1);
    expect(gridBlocks[0].heading).toBe("Our Features");

    const cardBlocks = await Effect.runPromise(
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        return yield* sql.unsafe<Record<string, any>>(
          'SELECT * FROM "block_feature_card" WHERE _root_record_id = ?',
          [record.id]
        );
      }).pipe(Effect.provide(sqlLayer))
    );
    expect(cardBlocks).toHaveLength(2);
  });

  it("resolves nested blocks in GraphQL", async () => {
    const gridBlockId = "01HNESTED_GQL_GRID";
    const card1Id = "01HNESTED_GQL_CARD1";
    const card2Id = "01HNESTED_GQL_CARD2";

    await jsonRequest(handler, "POST", "/api/records", {
      modelApiKey: "page",
      data: {
        title: "Features Page",
        content: {
          value: {
            schema: "dast",
            document: {
              type: "root",
              children: [{ type: "block", item: gridBlockId }],
            },
          },
          blocks: {
            [gridBlockId]: {
              _type: "feature_grid",
              heading: "Why Choose Us",
              features: {
                value: {
                  schema: "dast",
                  document: {
                    type: "root",
                    children: [
                      { type: "block", item: card1Id },
                      { type: "block", item: card2Id },
                    ],
                  },
                },
                blocks: {
                  [card1Id]: { _type: "feature_card", title: "Fast", description: "Speed" },
                  [card2Id]: { _type: "feature_card", title: "Easy", description: "Simple" },
                },
              },
            },
          },
        },
      },
    });

    const result = await gqlQuery(handler, `{
      allPages {
        title
        content {
          value
          blocks {
            __typename
            ... on FeatureGridRecord {
              heading
              features {
                value
                blocks {
                  ... on FeatureCardRecord { title description }
                }
              }
            }
          }
          inlineBlocks { __typename }
          links
        }
      }
    }`);

    expect(result.errors).toBeUndefined();
    const page = result.data.allPages[0];
    expect(page.title).toBe("Features Page");

    // The content blocks should include the feature_grid
    expect(page.content.blocks.length).toBeGreaterThanOrEqual(1);
    const gridBlock = page.content.blocks.find((b: any) => b.__typename === "FeatureGridRecord");
    expect(gridBlock).toBeDefined();
    expect(gridBlock.heading).toBe("Why Choose Us");

    // The feature_grid's "features" field resolves nested typed blocks from normalized storage
    expect(gridBlock.features).toBeDefined();
    expect(gridBlock.features.blocks).toHaveLength(2);
  });
});
