import { describe, it, expect, beforeEach } from "vitest";
import { createTestApp, jsonRequest, gqlQuery } from "./app-helpers.js";

describe("GraphQL StructuredText Resolution", () => {
  let handler: (req: Request) => Promise<Response>;

  beforeEach(async () => {
    ({ handler } = createTestApp());

    // Create block types
    const heroRes = await jsonRequest(handler, "POST", "/api/models", {
      name: "Hero Section", apiKey: "hero_section", isBlock: true,
    });
    const hero = await heroRes.json();
    await jsonRequest(handler, "POST", `/api/models/${hero.id}/fields`, { label: "Headline", apiKey: "headline", fieldType: "string" });
    await jsonRequest(handler, "POST", `/api/models/${hero.id}/fields`, { label: "CTA URL", apiKey: "cta_url", fieldType: "string" });

    const ctaRes = await jsonRequest(handler, "POST", "/api/models", {
      name: "CTA Banner", apiKey: "cta_banner", isBlock: true,
    });
    const cta = await ctaRes.json();
    await jsonRequest(handler, "POST", `/api/models/${cta.id}/fields`, { label: "Text", apiKey: "text", fieldType: "string" });
    await jsonRequest(handler, "POST", `/api/models/${cta.id}/fields`, { label: "URL", apiKey: "url", fieldType: "string" });

    // Create content model
    const pageRes = await jsonRequest(handler, "POST", "/api/models", { name: "Page", apiKey: "page" });
    const page = await pageRes.json();
    await jsonRequest(handler, "POST", `/api/models/${page.id}/fields`, { label: "Title", apiKey: "title", fieldType: "string" });
    await jsonRequest(handler, "POST", `/api/models/${page.id}/fields`, {
      label: "Content", apiKey: "content", fieldType: "structured_text",
      validators: { structured_text_blocks: ["hero_section", "cta_banner"] },
    });
  });

  it("returns { value, blocks, links } for StructuredText fields", async () => {
    const heroBlockId = "01HTEST_HERO_GQL";
    const ctaBlockId = "01HTEST_CTA_GQL";

    await jsonRequest(handler, "POST", "/api/records", {
      modelApiKey: "page",
      data: {
        title: "Home",
        content: {
          value: {
            schema: "dast",
            document: {
              type: "root",
              children: [
                { type: "paragraph", children: [{ type: "span", value: "Welcome" }] },
                { type: "block", item: heroBlockId },
                { type: "block", item: ctaBlockId },
              ],
            },
          },
          blocks: {
            [heroBlockId]: { _type: "hero_section", headline: "Build amazing things", cta_url: "https://example.com" },
            [ctaBlockId]: { _type: "cta_banner", text: "Get started", url: "https://example.com/start" },
          },
        },
      },
    });

    const result = await gqlQuery(handler, `{
      allPages {
        title
        content {
          value
          blocks
          links
        }
      }
    }`);

    expect(result.errors).toBeUndefined();
    const page = result.data.allPages[0];
    expect(page.title).toBe("Home");

    // value is the DAST document
    expect(page.content.value.schema).toBe("dast");
    expect(page.content.value.document.children).toHaveLength(3);

    // blocks are the resolved block records
    expect(page.content.blocks).toHaveLength(2);
    const heroBlock = page.content.blocks.find((b: any) => b.headline === "Build amazing things");
    expect(heroBlock).toBeDefined();
    expect(heroBlock.cta_url).toBe("https://example.com");

    const ctaBlock = page.content.blocks.find((b: any) => b.text === "Get started");
    expect(ctaBlock).toBeDefined();
    expect(ctaBlock.url).toBe("https://example.com/start");

    // links is empty for now (no itemLink/inlineItem in the DAST)
    expect(page.content.links).toEqual([]);
  });

  it("returns null for empty StructuredText field", async () => {
    await jsonRequest(handler, "POST", "/api/records", {
      modelApiKey: "page",
      data: { title: "Empty Page" },
    });

    const result = await gqlQuery(handler, `{ allPages { title content { value blocks links } } }`);
    expect(result.errors).toBeUndefined();
    expect(result.data.allPages[0].content).toBeNull();
  });

  it("returns StructuredText with prose only (no blocks)", async () => {
    await jsonRequest(handler, "POST", "/api/records", {
      modelApiKey: "page",
      data: {
        title: "Prose Page",
        content: {
          value: {
            schema: "dast",
            document: {
              type: "root",
              children: [
                { type: "paragraph", children: [{ type: "span", value: "Just text" }] },
                { type: "heading", level: 2, children: [{ type: "span", value: "A heading" }] },
              ],
            },
          },
          blocks: {},
        },
      },
    });

    const result = await gqlQuery(handler, `{ allPages { title content { value blocks links } } }`);
    expect(result.errors).toBeUndefined();
    const page = result.data.allPages[0];
    expect(page.content.value.document.children).toHaveLength(2);
    expect(page.content.blocks).toEqual([]);
  });
});
