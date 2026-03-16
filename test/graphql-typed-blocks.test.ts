import { describe, it, expect, beforeEach } from "vitest";
import { createTestApp, jsonRequest, gqlQuery } from "./app-helpers.js";

describe("GraphQL Typed Block Unions", () => {
  let handler: (req: Request) => Promise<Response>;

  beforeEach(async () => {
    ({ handler } = createTestApp());
  });

  it("resolves typed blocks via inline fragments", async () => {
    // Create block types
    const heroRes = await jsonRequest(handler, "POST", "/api/models", {
      name: "Hero Section", apiKey: "hero_section", isBlock: true,
    });
    const hero = await heroRes.json();
    await jsonRequest(handler, "POST", `/api/models/${hero.id}/fields`, {
      label: "Headline", apiKey: "headline", fieldType: "string",
    });
    await jsonRequest(handler, "POST", `/api/models/${hero.id}/fields`, {
      label: "Subheadline", apiKey: "subheadline", fieldType: "string",
    });

    const codeRes = await jsonRequest(handler, "POST", "/api/models", {
      name: "Code Block", apiKey: "code_block", isBlock: true,
    });
    const code = await codeRes.json();
    await jsonRequest(handler, "POST", `/api/models/${code.id}/fields`, {
      label: "Code", apiKey: "code", fieldType: "text",
    });
    await jsonRequest(handler, "POST", `/api/models/${code.id}/fields`, {
      label: "Language", apiKey: "language", fieldType: "string",
    });

    // Create content model with structured_text field whitelisting both blocks
    const postRes = await jsonRequest(handler, "POST", "/api/models", {
      name: "Post", apiKey: "post",
    });
    const post = await postRes.json();
    await jsonRequest(handler, "POST", `/api/models/${post.id}/fields`, {
      label: "Title", apiKey: "title", fieldType: "string",
    });
    await jsonRequest(handler, "POST", `/api/models/${post.id}/fields`, {
      label: "Content", apiKey: "content", fieldType: "structured_text",
      validators: { structured_text_blocks: ["hero_section", "code_block"] },
    });

    // Create record with blocks
    const heroBlockId = "01HTYPED_HERO_01";
    const codeBlockId = "01HTYPED_CODE_01";
    await jsonRequest(handler, "POST", "/api/records", {
      modelApiKey: "post",
      data: {
        title: "Typed Blocks Post",
        content: {
          value: {
            schema: "dast",
            document: {
              type: "root",
              children: [
                { type: "paragraph", children: [{ type: "span", value: "Intro" }] },
                { type: "block", item: heroBlockId },
                { type: "block", item: codeBlockId },
              ],
            },
          },
          blocks: {
            [heroBlockId]: { _type: "hero_section", headline: "Welcome", subheadline: "To the future" },
            [codeBlockId]: { _type: "code_block", code: "console.log('hi')", language: "javascript" },
          },
        },
      },
    });

    const result = await gqlQuery(handler, `{
      allPosts {
        title
        content {
          value
          blocks {
            ... on HeroSectionRecord { headline subheadline }
            ... on CodeBlockRecord { code language }
          }
        }
      }
    }`);

    expect(result.errors).toBeUndefined();
    const p = result.data.allPosts[0];
    expect(p.title).toBe("Typed Blocks Post");
    expect(p.content.blocks).toHaveLength(2);

    const heroBlock = p.content.blocks.find((b: any) => b.headline === "Welcome");
    expect(heroBlock).toBeDefined();
    expect(heroBlock.subheadline).toBe("To the future");

    const codeBlock = p.content.blocks.find((b: any) => b.code === "console.log('hi')");
    expect(codeBlock).toBeDefined();
    expect(codeBlock.language).toBe("javascript");
  });

  it("returns correct __typename on typed blocks", async () => {
    const heroRes = await jsonRequest(handler, "POST", "/api/models", {
      name: "Hero Section", apiKey: "hero_section", isBlock: true,
    });
    const hero = await heroRes.json();
    await jsonRequest(handler, "POST", `/api/models/${hero.id}/fields`, {
      label: "Headline", apiKey: "headline", fieldType: "string",
    });

    const codeRes = await jsonRequest(handler, "POST", "/api/models", {
      name: "Code Block", apiKey: "code_block", isBlock: true,
    });
    const code = await codeRes.json();
    await jsonRequest(handler, "POST", `/api/models/${code.id}/fields`, {
      label: "Code", apiKey: "code", fieldType: "text",
    });

    const postRes = await jsonRequest(handler, "POST", "/api/models", {
      name: "Post", apiKey: "post",
    });
    const post = await postRes.json();
    await jsonRequest(handler, "POST", `/api/models/${post.id}/fields`, {
      label: "Title", apiKey: "title", fieldType: "string",
    });
    await jsonRequest(handler, "POST", `/api/models/${post.id}/fields`, {
      label: "Content", apiKey: "content", fieldType: "structured_text",
      validators: { structured_text_blocks: ["hero_section", "code_block"] },
    });

    await jsonRequest(handler, "POST", "/api/records", {
      modelApiKey: "post",
      data: {
        title: "Typename Test",
        content: {
          value: {
            schema: "dast",
            document: {
              type: "root",
              children: [
                { type: "block", item: "01HTYPENAME_HERO" },
                { type: "block", item: "01HTYPENAME_CODE" },
              ],
            },
          },
          blocks: {
            "01HTYPENAME_HERO": { _type: "hero_section", headline: "Hello" },
            "01HTYPENAME_CODE": { _type: "code_block", code: "x = 1" },
          },
        },
      },
    });

    const result = await gqlQuery(handler, `{
      allPosts {
        content {
          blocks {
            __typename
            ... on HeroSectionRecord { headline }
            ... on CodeBlockRecord { code }
          }
        }
      }
    }`);

    expect(result.errors).toBeUndefined();
    const blocks = result.data.allPosts[0].content.blocks;
    const typeNames = blocks.map((b: any) => b.__typename).sort();
    expect(typeNames).toEqual(["CodeBlockRecord", "HeroSectionRecord"]);
  });

  it("falls back to generic StructuredText when no whitelist", async () => {
    // Create a content model with structured_text but NO whitelist
    const articleRes = await jsonRequest(handler, "POST", "/api/models", {
      name: "Article", apiKey: "article",
    });
    const article = await articleRes.json();
    await jsonRequest(handler, "POST", `/api/models/${article.id}/fields`, {
      label: "Title", apiKey: "title", fieldType: "string",
    });
    await jsonRequest(handler, "POST", `/api/models/${article.id}/fields`, {
      label: "Body", apiKey: "body", fieldType: "structured_text",
      // No validators — no structured_text_blocks
    });

    await jsonRequest(handler, "POST", "/api/records", {
      modelApiKey: "article",
      data: {
        title: "Generic ST",
        body: {
          value: {
            schema: "dast",
            document: {
              type: "root",
              children: [
                { type: "paragraph", children: [{ type: "span", value: "Plain text" }] },
              ],
            },
          },
          blocks: {},
        },
      },
    });

    // Query using generic StructuredText shape (blocks is [JSON!]!)
    const result = await gqlQuery(handler, `{
      allArticles {
        body {
          value
          blocks
        }
      }
    }`);

    expect(result.errors).toBeUndefined();
    const a = result.data.allArticles[0];
    expect(a.body.value.schema).toBe("dast");
    expect(a.body.blocks).toEqual([]);
  });

  it("resolves media field inside a typed block", async () => {
    // Create an asset
    const assetRes = await jsonRequest(handler, "POST", "/api/assets", {
      filename: "hero.jpg",
      mimeType: "image/jpeg",
      size: 50000,
      width: 1200,
      height: 800,
    });
    expect(assetRes.status).toBeLessThan(300);
    const asset = await assetRes.json();

    // Create block with media field
    const heroRes = await jsonRequest(handler, "POST", "/api/models", {
      name: "Image Block", apiKey: "image_block", isBlock: true,
    });
    const hero = await heroRes.json();
    await jsonRequest(handler, "POST", `/api/models/${hero.id}/fields`, {
      label: "Caption", apiKey: "caption", fieldType: "string",
    });
    await jsonRequest(handler, "POST", `/api/models/${hero.id}/fields`, {
      label: "Image", apiKey: "image", fieldType: "media",
    });

    const postRes = await jsonRequest(handler, "POST", "/api/models", {
      name: "Post", apiKey: "post",
    });
    const post = await postRes.json();
    await jsonRequest(handler, "POST", `/api/models/${post.id}/fields`, {
      label: "Title", apiKey: "title", fieldType: "string",
    });
    await jsonRequest(handler, "POST", `/api/models/${post.id}/fields`, {
      label: "Content", apiKey: "content", fieldType: "structured_text",
      validators: { structured_text_blocks: ["image_block"] },
    });

    await jsonRequest(handler, "POST", "/api/records", {
      modelApiKey: "post",
      data: {
        title: "Media Block Test",
        content: {
          value: {
            schema: "dast",
            document: {
              type: "root",
              children: [{ type: "block", item: "01HMEDIA_BLK_01" }],
            },
          },
          blocks: {
            "01HMEDIA_BLK_01": {
              _type: "image_block",
              caption: "A photo",
              image: asset.id,
            },
          },
        },
      },
    });

    const result = await gqlQuery(handler, `{
      allPosts {
        content {
          blocks {
            ... on ImageBlockRecord {
              caption
              image {
                id
                filename
                url
              }
            }
          }
        }
      }
    }`);

    expect(result.errors).toBeUndefined();
    const block = result.data.allPosts[0].content.blocks[0];
    expect(block.caption).toBe("A photo");
    expect(block.image).toBeDefined();
    expect(block.image.id).toBe(asset.id);
    expect(block.image.filename).toBe("hero.jpg");
    expect(block.image.url).toContain("hero.jpg");
  });

  it("resolves link field inside a typed block", async () => {
    // Create a target content model
    const authorRes = await jsonRequest(handler, "POST", "/api/models", {
      name: "Author", apiKey: "author",
    });
    const author = await authorRes.json();
    await jsonRequest(handler, "POST", `/api/models/${author.id}/fields`, {
      label: "Name", apiKey: "name", fieldType: "string",
    });

    // Create block with link field
    const quoteRes = await jsonRequest(handler, "POST", "/api/models", {
      name: "Quote Block", apiKey: "quote_block", isBlock: true,
    });
    const quote = await quoteRes.json();
    await jsonRequest(handler, "POST", `/api/models/${quote.id}/fields`, {
      label: "Text", apiKey: "text", fieldType: "string",
    });
    await jsonRequest(handler, "POST", `/api/models/${quote.id}/fields`, {
      label: "Author", apiKey: "author", fieldType: "link",
      validators: { item_item_type: ["author"] },
    });

    const postRes = await jsonRequest(handler, "POST", "/api/models", {
      name: "Post", apiKey: "post",
    });
    const post = await postRes.json();
    await jsonRequest(handler, "POST", `/api/models/${post.id}/fields`, {
      label: "Title", apiKey: "title", fieldType: "string",
    });
    await jsonRequest(handler, "POST", `/api/models/${post.id}/fields`, {
      label: "Content", apiKey: "content", fieldType: "structured_text",
      validators: { structured_text_blocks: ["quote_block"] },
    });

    // Create an author record
    const authorRecRes = await jsonRequest(handler, "POST", "/api/records", {
      modelApiKey: "author",
      data: { name: "Jane Doe" },
    });
    const authorRec = await authorRecRes.json();

    // Create post with quote block linking to author
    await jsonRequest(handler, "POST", "/api/records", {
      modelApiKey: "post",
      data: {
        title: "Link Block Test",
        content: {
          value: {
            schema: "dast",
            document: {
              type: "root",
              children: [{ type: "block", item: "01HLINK_BLK_01" }],
            },
          },
          blocks: {
            "01HLINK_BLK_01": {
              _type: "quote_block",
              text: "To be or not to be",
              author: authorRec.id,
            },
          },
        },
      },
    });

    const result = await gqlQuery(handler, `{
      allPosts {
        content {
          blocks {
            ... on QuoteBlockRecord {
              text
              author {
                name
              }
            }
          }
        }
      }
    }`);

    expect(result.errors).toBeUndefined();
    const block = result.data.allPosts[0].content.blocks[0];
    expect(block.text).toBe("To be or not to be");
    expect(block.author).toBeDefined();
    expect(block.author.name).toBe("Jane Doe");
  });
});
