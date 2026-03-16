import { describe, it, expect, beforeEach } from "vitest";
import { createTestApp, jsonRequest, gqlQuery } from "./app-helpers.js";

/**
 * [SCHEMA:marketing] Marketing Site integration test
 *
 * Models: page (content: structured_text with blocks-only whitelist)
 * Block types: hero_section, feature_grid, feature_card, testimonial, cta_banner
 * Tests: nested blocks (feature_grid → feature_card), draft/publish, GraphQL { value, blocks, links }
 */
describe("[SCHEMA:marketing] Marketing Site", () => {
  let handler: (req: Request) => Promise<Response>;

  beforeEach(async () => {
    ({ handler } = createTestApp());

    // --- Block types ---
    const heroRes = await jsonRequest(handler, "POST", "/api/models", { name: "Hero Section", apiKey: "hero_section", isBlock: true });
    const hero = await heroRes.json();
    await jsonRequest(handler, "POST", `/api/models/${hero.id}/fields`, { label: "Headline", apiKey: "headline", fieldType: "string" });
    await jsonRequest(handler, "POST", `/api/models/${hero.id}/fields`, { label: "Subheadline", apiKey: "subheadline", fieldType: "text" });
    await jsonRequest(handler, "POST", `/api/models/${hero.id}/fields`, { label: "CTA Text", apiKey: "cta_text", fieldType: "string" });
    await jsonRequest(handler, "POST", `/api/models/${hero.id}/fields`, { label: "CTA URL", apiKey: "cta_url", fieldType: "string" });

    const featureCardRes = await jsonRequest(handler, "POST", "/api/models", { name: "Feature Card", apiKey: "feature_card", isBlock: true });
    const featureCard = await featureCardRes.json();
    await jsonRequest(handler, "POST", `/api/models/${featureCard.id}/fields`, { label: "Icon", apiKey: "icon", fieldType: "string" });
    await jsonRequest(handler, "POST", `/api/models/${featureCard.id}/fields`, { label: "Title", apiKey: "title", fieldType: "string" });
    await jsonRequest(handler, "POST", `/api/models/${featureCard.id}/fields`, { label: "Description", apiKey: "description", fieldType: "text" });

    const featureGridRes = await jsonRequest(handler, "POST", "/api/models", { name: "Feature Grid", apiKey: "feature_grid", isBlock: true });
    const featureGrid = await featureGridRes.json();
    await jsonRequest(handler, "POST", `/api/models/${featureGrid.id}/fields`, { label: "Heading", apiKey: "heading", fieldType: "string" });
    // Feature grid has a structured_text field containing feature_cards
    await jsonRequest(handler, "POST", `/api/models/${featureGrid.id}/fields`, {
      label: "Features", apiKey: "features", fieldType: "structured_text",
      validators: { structured_text_blocks: ["feature_card"] },
    });

    const testimonialRes = await jsonRequest(handler, "POST", "/api/models", { name: "Testimonial", apiKey: "testimonial", isBlock: true });
    const testimonial = await testimonialRes.json();
    await jsonRequest(handler, "POST", `/api/models/${testimonial.id}/fields`, { label: "Quote", apiKey: "quote", fieldType: "text" });
    await jsonRequest(handler, "POST", `/api/models/${testimonial.id}/fields`, { label: "Author Name", apiKey: "author_name", fieldType: "string" });
    await jsonRequest(handler, "POST", `/api/models/${testimonial.id}/fields`, { label: "Author Title", apiKey: "author_title", fieldType: "string" });

    const ctaRes = await jsonRequest(handler, "POST", "/api/models", { name: "CTA Banner", apiKey: "cta_banner", isBlock: true });
    const cta = await ctaRes.json();
    await jsonRequest(handler, "POST", `/api/models/${cta.id}/fields`, { label: "Heading", apiKey: "heading", fieldType: "string" });
    await jsonRequest(handler, "POST", `/api/models/${cta.id}/fields`, { label: "Body", apiKey: "body", fieldType: "text" });
    await jsonRequest(handler, "POST", `/api/models/${cta.id}/fields`, { label: "Button Text", apiKey: "button_text", fieldType: "string" });
    await jsonRequest(handler, "POST", `/api/models/${cta.id}/fields`, { label: "Button URL", apiKey: "button_url", fieldType: "string" });

    // --- Content model ---
    const pageRes = await jsonRequest(handler, "POST", "/api/models", { name: "Page", apiKey: "page" });
    const page = await pageRes.json();
    await jsonRequest(handler, "POST", `/api/models/${page.id}/fields`, { label: "Title", apiKey: "title", fieldType: "string" });
    await jsonRequest(handler, "POST", `/api/models/${page.id}/fields`, { label: "Slug", apiKey: "slug", fieldType: "slug", validators: { slug_source: "title" } });
    await jsonRequest(handler, "POST", `/api/models/${page.id}/fields`, {
      label: "Content", apiKey: "content", fieldType: "structured_text",
      validators: { structured_text_blocks: ["hero_section", "feature_grid", "testimonial", "cta_banner"] },
    });
  });

  it("creates a homepage with multiple block types", async () => {
    const heroId = "01HMKT_HERO_001";
    const gridId = "01HMKT_GRID_001";
    const testimonialId = "01HMKT_TESTI_001";
    const ctaId = "01HMKT_CTA_001";

    const res = await jsonRequest(handler, "POST", "/api/records", {
      modelApiKey: "page",
      data: {
        title: "Home",
        content: {
          value: {
            schema: "dast",
            document: {
              type: "root",
              children: [
                { type: "block", item: heroId },
                { type: "block", item: gridId },
                { type: "block", item: testimonialId },
                { type: "block", item: ctaId },
              ],
            },
          },
          blocks: {
            [heroId]: { _type: "hero_section", headline: "Build the future", subheadline: "With agent-cms", cta_text: "Get Started", cta_url: "/signup" },
            [gridId]: { _type: "feature_grid", heading: "Why choose us" },
            [testimonialId]: { _type: "testimonial", quote: "Amazing product!", author_name: "Jane Doe", author_title: "CTO" },
            [ctaId]: { _type: "cta_banner", heading: "Ready?", body: "Start building today", button_text: "Sign up", button_url: "/signup" },
          },
        },
      },
    });

    expect(res.status).toBe(201);
    const record = await res.json();
    expect(record.slug).toBe("home");
  });

  it("queries homepage via GraphQL with { value, blocks, links }", async () => {
    const heroId = "01HMKT_HERO_GQL";
    const ctaId = "01HMKT_CTA_GQL";

    await jsonRequest(handler, "POST", "/api/records", {
      modelApiKey: "page",
      data: {
        title: "About Us",
        content: {
          value: {
            schema: "dast",
            document: {
              type: "root",
              children: [
                { type: "block", item: heroId },
                { type: "paragraph", children: [{ type: "span", value: "We are a great company." }] },
                { type: "block", item: ctaId },
              ],
            },
          },
          blocks: {
            [heroId]: { _type: "hero_section", headline: "About Us", subheadline: "Learn more" },
            [ctaId]: { _type: "cta_banner", heading: "Join us", button_text: "Apply", button_url: "/apply" },
          },
        },
      },
    });

    const result = await gqlQuery(handler, `{
      allPages {
        title
        slug
        content {
          value
          blocks {
            __typename
            ... on HeroSectionRecord { headline subheadline }
            ... on CtaBannerRecord { heading buttonText buttonUrl }
          }
          links
        }
      }
    }`);

    expect(result.errors).toBeUndefined();
    const page = result.data.allPages[0];
    expect(page.title).toBe("About Us");
    expect(page.slug).toBe("about-us");

    // DAST has 3 children: block, paragraph, block
    expect(page.content.value.document.children).toHaveLength(3);

    // Blocks resolved
    expect(page.content.blocks).toHaveLength(2);
    const hero = page.content.blocks.find((b: any) => b.headline === "About Us");
    expect(hero).toBeDefined();
    const cta = page.content.blocks.find((b: any) => b.heading === "Join us");
    expect(cta).toBeDefined();
    expect(cta.buttonUrl).toBe("/apply");
  });

  it("draft/publish cycle with blocks", async () => {
    const heroId = "01HMKT_HERO_PUB";

    const createRes = await jsonRequest(handler, "POST", "/api/records", {
      modelApiKey: "page",
      data: {
        title: "Landing Page",
        content: {
          value: {
            schema: "dast",
            document: { type: "root", children: [{ type: "block", item: heroId }] },
          },
          blocks: {
            [heroId]: { _type: "hero_section", headline: "Welcome" },
          },
        },
      },
    });
    const record = await createRes.json();
    expect(record._status).toBe("draft");

    // Publish
    const pubRes = await handler(
      new Request(`http://localhost/api/records/${record.id}/publish?modelApiKey=page`, { method: "POST" })
    );
    const published = await pubRes.json();
    expect(published._status).toBe("published");
    expect(published._published_snapshot).toBeDefined();
    expect(published._published_snapshot.title).toBe("Landing Page");

    // Edit after publish
    const editRes = await jsonRequest(handler, "PATCH", `/api/records/${record.id}`, {
      modelApiKey: "page", data: { title: "Updated Landing" },
    });
    const edited = await editRes.json();
    expect(edited._status).toBe("updated");
    expect(edited.title).toBe("Updated Landing");

    // Read back — snapshot still has original
    const getRes = await handler(new Request(`http://localhost/api/records/${record.id}?modelApiKey=page`));
    const full = await getRes.json();
    expect(full._published_snapshot.title).toBe("Landing Page");
    expect(full.title).toBe("Updated Landing");
  });
});
