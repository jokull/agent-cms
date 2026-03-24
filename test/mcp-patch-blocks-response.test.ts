import { describe, expect, it } from "vitest";
import { createTestApp } from "./app-helpers.js";
import { createTestMcpClient, parseToolResult as parse } from "./mcp-helpers.js";

describe("MCP patch_blocks response", () => {
  it("includes the patched field envelope alongside the compact summary", async () => {
    const { sqlLayer } = createTestApp();
    const { client } = await createTestMcpClient(sqlLayer);

    const noteBlock = parse(await client.callTool({
      name: "create_model",
      arguments: { name: "Note Block", apiKey: "note_block", isBlock: true },
    }));
    parse(await client.callTool({
      name: "create_field",
      arguments: { modelId: noteBlock.id, label: "Body", apiKey: "body", fieldType: "string" },
    }));

    const page = parse(await client.callTool({
      name: "create_model",
      arguments: { name: "Page", apiKey: "page" },
    }));
    parse(await client.callTool({
      name: "create_field",
      arguments: { modelId: page.id, label: "Content", apiKey: "content", fieldType: "structured_text", validators: { structured_text_blocks: ["note_block"] } },
    }));

    const created = parse(await client.callTool({
      name: "create_record",
      arguments: {
        modelApiKey: "page",
        data: {
          content: {
            markdown: "Intro\n\n<!-- cms:block:n1 -->",
            blocks: { n1: { _type: "note_block", body: "Original" } },
          },
        },
      },
    }));

    const patched = parse(await client.callTool({
      name: "patch_blocks",
      arguments: {
        modelApiKey: "page",
        recordId: created.id,
        fieldApiKey: "content",
        blocks: { n1: { body: "Updated" } },
      },
    }));

    expect(patched.fieldApiKey).toBe("content");
    expect(patched.blocks.n1.body).toBe("Updated");
    expect(patched.field.blocks.n1.body).toBe("Updated");
    expect(patched.field.value.document.children).toHaveLength(2);
  });
});
