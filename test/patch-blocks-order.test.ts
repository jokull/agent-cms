import { describe, it, expect, beforeEach } from "vitest";
import { Effect } from "effect";
import { SqlClient } from "@effect/sql";
import { createTestApp, jsonRequest } from "./app-helpers.js";

describe("patch_blocks — order array for block reordering", () => {
  let handler: (req: Request) => Promise<Response>;
  let sqlLayer: any;

  beforeEach(async () => {
    ({ handler, sqlLayer } = createTestApp());

    // Block type: section
    const sectionRes = await jsonRequest(handler, "POST", "/api/models", {
      name: "Section", apiKey: "section", isBlock: true,
    });
    const section = await sectionRes.json();
    await jsonRequest(handler, "POST", `/api/models/${section.id}/fields`, {
      label: "Title", apiKey: "title", fieldType: "string",
    });

    // Content model with blocks_only structured_text field
    const pageRes = await jsonRequest(handler, "POST", "/api/models", {
      name: "Page", apiKey: "page", hasDraft: false,
    });
    const page = await pageRes.json();
    await jsonRequest(handler, "POST", `/api/models/${page.id}/fields`, {
      label: "Name", apiKey: "name", fieldType: "string",
    });
    await jsonRequest(handler, "POST", `/api/models/${page.id}/fields`, {
      label: "Sections", apiKey: "sections", fieldType: "structured_text",
      validators: {
        structured_text_blocks: ["section"],
        blocks_only: true,
      },
    });

    // Block type: venue (for mixed content model tests)
    const venueRes = await jsonRequest(handler, "POST", "/api/models", {
      name: "Venue", apiKey: "venue", isBlock: true,
    });
    const venue = await venueRes.json();
    await jsonRequest(handler, "POST", `/api/models/${venue.id}/fields`, {
      label: "Name", apiKey: "name", fieldType: "string",
    });

    // Content model with non-blocks_only structured_text field
    const guideRes = await jsonRequest(handler, "POST", "/api/models", {
      name: "Guide", apiKey: "guide", hasDraft: false,
    });
    const guide = await guideRes.json();
    await jsonRequest(handler, "POST", `/api/models/${guide.id}/fields`, {
      label: "Title", apiKey: "title", fieldType: "string",
    });
    await jsonRequest(handler, "POST", `/api/models/${guide.id}/fields`, {
      label: "Content", apiKey: "content", fieldType: "structured_text",
      validators: { structured_text_blocks: ["venue"] },
    });
  });

  function getBlocks(tableName: string, recordId: string) {
    return Effect.runPromise(
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        return yield* sql.unsafe<Record<string, unknown>>(
          `SELECT * FROM "${tableName}" WHERE _root_record_id = ? ORDER BY id`,
          [recordId]
        );
      }).pipe(Effect.provide(sqlLayer))
    );
  }

  async function createPageWithSections() {
    const res = await jsonRequest(handler, "POST", "/api/records", {
      modelApiKey: "page",
      data: {
        name: "My Page",
        sections: {
          value: {
            schema: "dast",
            document: {
              type: "root",
              children: [
                { type: "block", item: "s1" },
                { type: "block", item: "s2" },
                { type: "block", item: "s3" },
              ],
            },
          },
          blocks: {
            s1: { _type: "section", title: "Introduction" },
            s2: { _type: "section", title: "Main Content" },
            s3: { _type: "section", title: "Conclusion" },
          },
        },
      },
    });
    expect(res.status).toBe(201);
    return res.json();
  }

  async function createGuideWithVenues() {
    const res = await jsonRequest(handler, "POST", "/api/records", {
      modelApiKey: "guide",
      data: {
        title: "Food Guide",
        content: {
          value: {
            schema: "dast",
            document: {
              type: "root",
              children: [
                { type: "block", item: "v1" },
                { type: "block", item: "v2" },
              ],
            },
          },
          blocks: {
            v1: { _type: "venue", name: "Grillid" },
            v2: { _type: "venue", name: "Dill" },
          },
        },
      },
    });
    expect(res.status).toBe(201);
    return res.json();
  }

  it("reorders blocks on a blocks_only field", async () => {
    const record = await createPageWithSections();

    const patchRes = await jsonRequest(handler, "PATCH", `/api/records/${record.id}/blocks`, {
      modelApiKey: "page",
      fieldApiKey: "sections",
      order: ["s3", "s1", "s2"],
      blocks: {},
    });
    expect(patchRes.status).toBe(200);

    const updated = await patchRes.json();
    const sections = typeof updated.sections === "string" ? JSON.parse(updated.sections) : updated.sections;
    const children = sections.value.document.children;
    expect(children).toHaveLength(3);
    expect(children[0].item).toBe("s3");
    expect(children[1].item).toBe("s1");
    expect(children[2].item).toBe("s2");

    // All blocks still exist
    const blocks = await getBlocks("block_section", record.id);
    expect(blocks).toHaveLength(3);
  });

  it("rejects order on a non-blocks_only field", async () => {
    const record = await createGuideWithVenues();

    const patchRes = await jsonRequest(handler, "PATCH", `/api/records/${record.id}/blocks`, {
      modelApiKey: "guide",
      fieldApiKey: "content",
      order: ["v2", "v1"],
      blocks: {},
    });
    expect(patchRes.status).toBe(400);
    const body = await patchRes.json();
    expect(body.error).toContain("blocks_only");
  });

  it("rejects order combined with value", async () => {
    const record = await createPageWithSections();

    const patchRes = await jsonRequest(handler, "PATCH", `/api/records/${record.id}/blocks`, {
      modelApiKey: "page",
      fieldApiKey: "sections",
      order: ["s1", "s2", "s3"],
      value: {
        schema: "dast",
        document: {
          type: "root",
          children: [{ type: "block", item: "s1" }],
        },
      },
      blocks: {},
    });
    expect(patchRes.status).toBe(400);
    const body = await patchRes.json();
    expect(body.error).toContain("Cannot use both 'order' and 'value'");
  });

  it("applies patches and reorders in the same call", async () => {
    const record = await createPageWithSections();

    const patchRes = await jsonRequest(handler, "PATCH", `/api/records/${record.id}/blocks`, {
      modelApiKey: "page",
      fieldApiKey: "sections",
      order: ["s2", "s3", "s1"],
      blocks: {
        s1: { title: "Updated Introduction" },
      },
    });
    expect(patchRes.status).toBe(200);

    const updated = await patchRes.json();
    const sections = typeof updated.sections === "string" ? JSON.parse(updated.sections) : updated.sections;

    // Check order
    const children = sections.value.document.children;
    expect(children[0].item).toBe("s2");
    expect(children[1].item).toBe("s3");
    expect(children[2].item).toBe("s1");

    // Check patch was applied
    const blocks = await getBlocks("block_section", record.id);
    const s1 = blocks.find((b) => b.id === "s1");
    expect(s1?.title).toBe("Updated Introduction");

    // Other blocks unchanged
    const s2 = blocks.find((b) => b.id === "s2");
    expect(s2?.title).toBe("Main Content");
  });

  it("rejects order with a missing block ID", async () => {
    const record = await createPageWithSections();

    const patchRes = await jsonRequest(handler, "PATCH", `/api/records/${record.id}/blocks`, {
      modelApiKey: "page",
      fieldApiKey: "sections",
      order: ["s1", "s2", "nonexistent"],
      blocks: {},
    });
    expect(patchRes.status).toBe(400);
  });

  it("rejects order that omits an existing block ID", async () => {
    const record = await createPageWithSections();

    // Only list s1 and s2, omitting s3
    const patchRes = await jsonRequest(handler, "PATCH", `/api/records/${record.id}/blocks`, {
      modelApiKey: "page",
      fieldApiKey: "sections",
      order: ["s1", "s2"],
      blocks: {},
    });
    expect(patchRes.status).toBe(400);
  });
});
