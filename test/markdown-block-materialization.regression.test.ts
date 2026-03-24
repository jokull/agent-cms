import { describe, it, expect } from "vitest";
import { createTestApp } from "./app-helpers.js";
import { createTestMcpClient, parseToolResult as parse } from "./mcp-helpers.js";

describe("markdown block materialization after create_record", () => {
  it("get_record returns persisted block fields after markdown+blocks create", async () => {
    const { sqlLayer } = createTestApp();
    const { client } = await createTestMcpClient(sqlLayer);

    const block = parse(await client.callTool({
      name: "create_model",
      arguments: { name: "Code Snippet", apiKey: "code_snippet", isBlock: true },
    }));
    parse(await client.callTool({
      name: "create_field",
      arguments: { modelId: block.id, label: "Language", apiKey: "language", fieldType: "string" },
    }));
    parse(await client.callTool({
      name: "create_field",
      arguments: { modelId: block.id, label: "Code", apiKey: "code", fieldType: "text" },
    }));

    const doc = parse(await client.callTool({
      name: "create_model",
      arguments: { name: "Doc", apiKey: "doc" },
    }));
    parse(await client.callTool({
      name: "create_field",
      arguments: { modelId: doc.id, label: "Body", apiKey: "body", fieldType: "structured_text", validators: { structured_text_blocks: ["code_snippet"] } },
    }));

    const created = parse(await client.callTool({
      name: "create_record",
      arguments: {
        modelApiKey: "doc",
        data: {
          body: {
            markdown: "Intro\n\n<!-- cms:block:snippet1 -->\n\nOutro",
            blocks: {
              snippet1: {
                _type: "code_snippet",
                language: "javascript",
                code: "const answer = 42;",
              },
            },
          },
        },
      },
    }));

    const fetched = parse(await client.callTool({
      name: "get_record",
      arguments: { modelApiKey: "doc", recordId: created.id },
    }));

    expect(fetched.body.blocks.snippet1.language).toBe("javascript");
    expect(fetched.body.blocks.snippet1.code).toBe("const answer = 42;");
  });
});
