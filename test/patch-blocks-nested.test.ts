import { describe, it, expect, beforeEach } from "vitest";
import { createTestApp, jsonRequest } from "./app-helpers.js";

describe("patch_blocks — nested structured_text", () => {
  let handler: (req: Request) => Promise<Response>;

  beforeEach(async () => {
    ({ handler } = createTestApp());

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

    const pageRes = await jsonRequest(handler, "POST", "/api/models", {
      name: "Page", apiKey: "page", hasDraft: false,
    });
    const page = await pageRes.json();
    await jsonRequest(handler, "POST", `/api/models/${page.id}/fields`, {
      label: "Title", apiKey: "title", fieldType: "string",
    });
    await jsonRequest(handler, "POST", `/api/models/${page.id}/fields`, {
      label: "Content", apiKey: "content", fieldType: "structured_text",
      validators: { structured_text_blocks: ["feature_grid"] },
    });
  });

  async function createNestedPage() {
    const res = await jsonRequest(handler, "POST", "/api/records", {
      modelApiKey: "page",
      data: {
        title: "Features Page",
        content: {
          value: {
            schema: "dast",
            document: {
              type: "root",
              children: [{ type: "block", item: "grid-1" }],
            },
          },
          blocks: {
            "grid-1": {
              _type: "feature_grid",
              heading: "Why Choose Us",
              features: {
                value: {
                  schema: "dast",
                  document: {
                    type: "root",
                    children: [
                      { type: "block", item: "card-1" },
                      { type: "block", item: "card-2" },
                    ],
                  },
                },
                blocks: {
                  "card-1": { _type: "feature_card", title: "Fast", description: "Speed" },
                  "card-2": { _type: "feature_card", title: "Easy", description: "Simple" },
                },
              },
            },
          },
        },
      },
    });
    expect(res.status).toBe(201);
    return res.json();
  }

  it("patches a nested block directly by nested block id", async () => {
    const record = await createNestedPage();

    const patchRes = await jsonRequest(handler, "PATCH", `/api/records/${record.id}/blocks`, {
      modelApiKey: "page",
      fieldApiKey: "content",
      blocks: {
        "card-1": { description: "Updated nested description" },
      },
    });
    expect(patchRes.status).toBe(200);

    const updated = await patchRes.json();
    const content = typeof updated.content === "string" ? JSON.parse(updated.content) : updated.content;
    const grid = content.blocks["grid-1"];
    expect(grid.features.blocks["card-1"].description).toBe("Updated nested description");
    expect(grid.features.blocks["card-2"].description).toBe("Simple");
  });

  it("deletes a nested block directly by nested block id", async () => {
    const record = await createNestedPage();

    const patchRes = await jsonRequest(handler, "PATCH", `/api/records/${record.id}/blocks`, {
      modelApiKey: "page",
      fieldApiKey: "content",
      blocks: {
        "card-2": null,
      },
    });
    expect(patchRes.status).toBe(200);

    const updated = await patchRes.json();
    const content = typeof updated.content === "string" ? JSON.parse(updated.content) : updated.content;
    const nested = content.blocks["grid-1"].features;
    expect(nested.blocks["card-2"]).toBeUndefined();
    expect(nested.value.document.children).toHaveLength(1);
    expect(nested.value.document.children[0].item).toBe("card-1");
  });
});
