import { describe, expect, it } from "vitest";
import { createTestApp, jsonRequest } from "./app-helpers.js";

describe("patch_blocks with optional null block fields", () => {
  it("allows partial block patches when unchanged optional fields are stored as null", async () => {
    const { handler } = createTestApp();

    const imageBlockRes = await jsonRequest(handler, "POST", "/api/models", {
      name: "Image Block",
      apiKey: "image_block",
      isBlock: true,
    });
    const imageBlock = await imageBlockRes.json();
    await jsonRequest(handler, "POST", `/api/models/${imageBlock.id}/fields`, {
      label: "Image",
      apiKey: "image",
      fieldType: "media",
    });
    await jsonRequest(handler, "POST", `/api/models/${imageBlock.id}/fields`, {
      label: "Caption",
      apiKey: "caption",
      fieldType: "string",
    });

    const postRes = await jsonRequest(handler, "POST", "/api/models", {
      name: "Post",
      apiKey: "post",
    });
    const post = await postRes.json();
    await jsonRequest(handler, "POST", `/api/models/${post.id}/fields`, {
      label: "Content",
      apiKey: "content",
      fieldType: "structured_text",
      validators: { structured_text_blocks: ["image_block"] },
    });

    const createRes = await jsonRequest(handler, "POST", "/api/records", {
      modelApiKey: "post",
      data: {
        content: {
          value: {
            schema: "dast",
            document: {
              type: "root",
              children: [{ type: "block", item: "img-1" }],
            },
          },
          blocks: {
            "img-1": { _type: "image_block", image: null, caption: "Original" },
          },
        },
      },
    });
    expect(createRes.status).toBe(201);
    const created = await createRes.json();

    const patchRes = await jsonRequest(handler, "PATCH", `/api/records/${created.id}/blocks`, {
      modelApiKey: "post",
      fieldApiKey: "content",
      blocks: {
        "img-1": { caption: "Updated" },
      },
    });

    expect(patchRes.status).toBe(200);
    const patched = await patchRes.json();
    const content = typeof patched.content === "string" ? JSON.parse(patched.content) : patched.content;
    expect(content.blocks["img-1"].caption).toBe("Updated");
    expect(content.blocks["img-1"].image).toBeNull();
  });
});
