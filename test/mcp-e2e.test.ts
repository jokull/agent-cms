import { describe, it, expect, beforeEach } from "vitest";
import { Effect } from "effect";
import { SqliteClient } from "@effect/sql-sqlite-node";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { createWebHandler } from "../src/http/router.js";
import { runMigrations } from "./migrate.js";
import { mkdtempSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { createTestMcpClient } from "./mcp-helpers.js";

/**
 * P5.6: End-to-end MCP test
 *
 * An AI agent creates the blog schema, inserts content with StructuredText
 * and blocks, publishes records, then queries via GraphQL. The full loop.
 */
describe("P5.6: End-to-end MCP → GraphQL", () => {
  let agent: Client;
  let graphqlHandler: (req: Request) => Promise<Response>;

  beforeEach(async () => {
    const tmpDir = mkdtempSync(join(tmpdir(), "agent-cms-e2e-"));
    const dbPath = join(tmpDir, "test.db");
    const sqlLayer = SqliteClient.layer({ filename: dbPath, disableWAL: true });

    Effect.runSync(runMigrations().pipe(Effect.provide(sqlLayer)));

    // MCP server + client
    ({ client: agent } = await createTestMcpClient(sqlLayer));

    // GraphQL handler (same DB)
    graphqlHandler = createWebHandler(sqlLayer).fetch;
  });

  function parse(res: any): any {
    if (res.isError) throw new Error(`Tool error: ${res.content[0]?.text}`);
    return JSON.parse(res.content[0]?.text ?? "null");
  }

  async function gql(query: string, opts?: { includeDrafts?: boolean }) {
    const headers: Record<string, string> = { "Content-Type": "application/json" };
    if (opts?.includeDrafts) headers["X-Include-Drafts"] = "true";
    const res = await graphqlHandler(new Request("http://localhost/graphql", {
      method: "POST", headers, body: JSON.stringify({ query }),
    }));
    return res.json() as Promise<{ data?: any; errors?: any[] }>;
  }

  it("agent builds a blog, creates content, and consumers query via GraphQL", async () => {
    // === Step 1: Agent discovers current state ===
    const initialResult = parse(await agent.callTool({ name: "schema_info", arguments: {} }));
    expect(initialResult.models).toEqual([]);

    // === Step 2: Agent creates the blog schema ===

    // Author (singleton)
    const author = parse(await agent.callTool({
      name: "create_model",
      arguments: { name: "Author", apiKey: "author", singleton: true },
    }));
    expect(author.apiKey).toBe("author");

    parse(await agent.callTool({
      name: "create_field",
      arguments: { modelId: author.id, label: "Name", apiKey: "name", fieldType: "string" },
    }));
    parse(await agent.callTool({
      name: "create_field",
      arguments: { modelId: author.id, label: "Bio", apiKey: "bio", fieldType: "text" },
    }));

    // Hero block type
    const heroBlock = parse(await agent.callTool({
      name: "create_model",
      arguments: { name: "Hero Section", apiKey: "hero_section", isBlock: true },
    }));
    parse(await agent.callTool({
      name: "create_field",
      arguments: { modelId: heroBlock.id, label: "Headline", apiKey: "headline", fieldType: "string" },
    }));
    parse(await agent.callTool({
      name: "create_field",
      arguments: { modelId: heroBlock.id, label: "CTA", apiKey: "cta_url", fieldType: "string" },
    }));

    // Blog post
    const post = parse(await agent.callTool({
      name: "create_model",
      arguments: { name: "Blog Post", apiKey: "blog_post" },
    }));
    parse(await agent.callTool({
      name: "create_field",
      arguments: { modelId: post.id, label: "Title", apiKey: "title", fieldType: "string" },
    }));
    parse(await agent.callTool({
      name: "create_field",
      arguments: { modelId: post.id, label: "Slug", apiKey: "slug", fieldType: "slug", validators: { slug_source: "title" } },
    }));
    parse(await agent.callTool({
      name: "create_field",
      arguments: { modelId: post.id, label: "Author", apiKey: "author", fieldType: "link", validators: { item_item_type: ["author"] } },
    }));
    parse(await agent.callTool({
      name: "create_field",
      arguments: {
        modelId: post.id, label: "Content", apiKey: "content", fieldType: "structured_text",
        validators: { structured_text_blocks: ["hero_section"] },
      },
    }));

    // Verify schema via discovery
    const schemaResult = parse(await agent.callTool({ name: "schema_info", arguments: {} }));
    expect(schemaResult.models).toHaveLength(3);
    const postDetail = parse(await agent.callTool({ name: "schema_info", arguments: { filterByName: "blog_post" } }));
    expect(postDetail.models[0].fields).toHaveLength(4);

    // === Step 3: Agent creates content ===

    const authorRecord = parse(await agent.callTool({
      name: "create_record",
      arguments: { modelApiKey: "author", data: { name: "Jokull Solberg", bio: "Building the future of CMS" } },
    }));
    expect(authorRecord.name).toBe("Jokull Solberg");

    const heroId = "01HE2E_HERO_001";
    const postRecord = parse(await agent.callTool({
      name: "create_record",
      arguments: {
        modelApiKey: "blog_post",
        data: {
          title: "Introducing agent-cms",
          author: authorRecord.id,
          content: {
            value: {
              schema: "dast",
              document: {
                type: "root",
                children: [
                  { type: "paragraph", children: [{ type: "span", value: "Today we're launching agent-cms, a headless CMS built for AI agents." }] },
                  { type: "block", item: heroId },
                  { type: "paragraph", children: [
                    { type: "span", value: "It's " },
                    { type: "span", value: "completely open source", marks: ["strong"] },
                    { type: "span", value: " and runs on Cloudflare." },
                  ]},
                ],
              },
            },
            blocks: {
              [heroId]: { _type: "hero_section", headline: "The CMS for AI", cta_url: "https://github.com/agent-cms" },
            },
          },
        },
      },
    }));
    expect(postRecord.slug).toBe("introducing-agent-cms");
    expect(postRecord._status).toBe("draft");

    // === Step 4: Agent publishes ===

    const published = parse(await agent.callTool({
      name: "publish_records",
      arguments: { recordIds: [authorRecord.id], modelApiKey: "author" },
    }));
    expect(published._status).toBe("published");

    parse(await agent.callTool({
      name: "publish_records",
      arguments: { recordIds: [postRecord.id], modelApiKey: "blog_post" },
    }));

    // === Step 5: Consumer queries via GraphQL ===

    // Without includeDrafts — published content
    const publicResult = await gql(`{
      allBlogPosts {
        title
        slug
        author { name bio }
        content {
          value
          blocks {
            __typename
            ... on HeroSectionRecord { headline ctaUrl }
          }
          inlineBlocks { __typename }
          links
        }
      }
    }`);

    expect(publicResult.errors).toBeUndefined();
    expect(publicResult.data.allBlogPosts).toHaveLength(1);

    const blogPost = publicResult.data.allBlogPosts[0];
    expect(blogPost.title).toBe("Introducing agent-cms");
    expect(blogPost.slug).toBe("introducing-agent-cms");
    expect(blogPost.author.name).toBe("Jokull Solberg");

    // StructuredText resolution
    expect(blogPost.content.value.schema).toBe("dast");
    expect(blogPost.content.value.document.children).toHaveLength(3);
    expect(blogPost.content.blocks).toHaveLength(1);
    expect(blogPost.content.blocks[0].__typename).toBe("HeroSectionRecord");
    expect(blogPost.content.blocks[0].headline).toBe("The CMS for AI");
    expect(blogPost.content.inlineBlocks).toEqual([]);
    expect(blogPost.content.links).toEqual([]);

    // Count
    const countResult = await gql(`{ _allBlogPostsMeta { count } }`);
    expect(countResult.data._allBlogPostsMeta.count).toBe(1);

    // Author singleton
    const authorResult = await gql(`{ allAuthors { name bio } }`);
    expect(authorResult.data.allAuthors).toHaveLength(1);
    expect(authorResult.data.allAuthors[0].name).toBe("Jokull Solberg");

    // === Step 6: Agent edits (creates "updated" state) ===

    parse(await agent.callTool({
      name: "update_record",
      arguments: {
        recordId: postRecord.id, modelApiKey: "blog_post",
        data: { title: "Introducing agent-cms v2" },
      },
    }));

    // Public API still shows original published title
    const afterEdit = await gql(`{ allBlogPosts { title } }`);
    expect(afterEdit.data.allBlogPosts[0].title).toBe("Introducing agent-cms");

    // Draft API shows updated title
    const draftResult = await gql(`{ allBlogPosts { title _status } }`, { includeDrafts: true });
    expect(draftResult.data.allBlogPosts[0].title).toBe("Introducing agent-cms v2");
    expect(draftResult.data.allBlogPosts[0]._status).toBe("updated");

    // === Step 7: Verify the full loop ===
    console.log("✅ End-to-end MCP → GraphQL test passed!");
    console.log("   Agent created: 3 models, 7 fields, 2 records, 1 block");
    console.log("   Agent published, edited, verified draft/published split");
    console.log("   GraphQL consumers see: StructuredText, linked records, meta counts");
  });
});
