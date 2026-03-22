import { describe, it, expect, beforeEach } from "vitest";
import { createTestApp, jsonRequest, gqlQuery } from "./app-helpers.js";

describe("SEO field type", () => {
  let handler: (req: Request) => Promise<Response>;
  let modelId: string;

  beforeEach(async () => {
    ({ handler } = createTestApp());

    const modelRes = await jsonRequest(handler, "POST", "/api/models", { name: "Page", apiKey: "page" });
    const model = await modelRes.json();
    modelId = model.id;

    await jsonRequest(handler, "POST", `/api/models/${model.id}/fields`, {
      label: "Title", apiKey: "title", fieldType: "string",
    });
    await jsonRequest(handler, "POST", `/api/models/${model.id}/fields`, {
      label: "SEO", apiKey: "seo", fieldType: "seo",
    });
  });

  it("stores and retrieves SEO data via REST", async () => {
    const createRes = await jsonRequest(handler, "POST", "/api/records", {
      modelApiKey: "page",
      data: {
        title: "About Us",
        seo: {
          title: "About Our Company | Example",
          description: "Learn about our mission and team.",
          twitterCard: "summary_large_image",
        },
      },
    });
    expect(createRes.status).toBe(201);
    const record = await createRes.json();
    expect(record.seo).toEqual({
      title: "About Our Company | Example",
      description: "Learn about our mission and team.",
      twitterCard: "summary_large_image",
    });
  });

  it("resolves SEO field in GraphQL without image", async () => {
    await jsonRequest(handler, "POST", "/api/records", {
      modelApiKey: "page",
      data: {
        title: "Home",
        seo: {
          title: "Home | Example",
          description: "Welcome to our site.",
        },
      },
    });

    const result = await gqlQuery(handler, `{
      allPages {
        title
        seo { title description image { id } twitterCard }
      }
    }`);

    expect(result.errors).toBeUndefined();
    const page = result.data.allPages[0];
    expect(page.seo.title).toBe("Home | Example");
    expect(page.seo.description).toBe("Welcome to our site.");
    expect(page.seo.image).toBeNull();
    expect(page.seo.twitterCard).toBeNull();
  });

  it("resolves SEO image to full Asset object via GraphQL", async () => {
    // Create an asset first
    const assetRes = await jsonRequest(handler, "POST", "/api/assets", {
      filename: "og-image.jpg", mimeType: "image/jpeg",
      size: 80000, width: 1200, height: 630, alt: "Open Graph image",
    });
    const asset = await assetRes.json();

    await jsonRequest(handler, "POST", "/api/records", {
      modelApiKey: "page",
      data: {
        title: "Blog",
        seo: {
          title: "Blog | Example",
          description: "Read our latest posts.",
          image: asset.id,
          twitterCard: "summary_large_image",
        },
      },
    });

    const result = await gqlQuery(handler, `{
      allPages {
        seo {
          title
          description
          twitterCard
          image { id filename mimeType width height alt url }
        }
      }
    }`);

    expect(result.errors).toBeUndefined();
    const seo = result.data.allPages[0].seo;
    expect(seo.title).toBe("Blog | Example");
    expect(seo.description).toBe("Read our latest posts.");
    expect(seo.twitterCard).toBe("summary_large_image");
    expect(seo.image.filename).toBe("og-image.jpg");
    expect(seo.image.width).toBe(1200);
    expect(seo.image.height).toBe(630);
    expect(seo.image.alt).toBe("Open Graph image");
    expect(seo.image.url).toContain(asset.id);
  });

  it("returns null for unset SEO field", async () => {
    await jsonRequest(handler, "POST", "/api/records", {
      modelApiKey: "page",
      data: { title: "Minimal" },
    });

    const result = await gqlQuery(handler, `{
      allPages { title seo { title description } }
    }`);

    expect(result.errors).toBeUndefined();
    expect(result.data.allPages[0].seo).toBeNull();
  });

  it("rejects SEO image references to missing assets on create", async () => {
    const createRes = await jsonRequest(handler, "POST", "/api/records", {
      modelApiKey: "page",
      data: {
        title: "Broken SEO",
        seo: {
          title: "Broken SEO | Example",
          image: "01NONEXISTENTASSET0000000000",
        },
      },
    });

    expect(createRes.status).toBe(400);
    expect(await createRes.text()).toContain("Asset(s) not found for field 'seo': 01NONEXISTENTASSET0000000000");
  });

  it("updates SEO field on existing record", async () => {
    const createRes = await jsonRequest(handler, "POST", "/api/records", {
      modelApiKey: "page",
      data: {
        title: "Contact",
        seo: { title: "Contact Us", description: "Get in touch." },
      },
    });
    const record = await createRes.json();

    const patchRes = await jsonRequest(handler, "PATCH", `/api/records/${record.id}`, {
      modelApiKey: "page",
      data: {
        seo: { title: "Contact Us | Updated", description: "We moved offices.", twitterCard: "summary" },
      },
    });
    expect(patchRes.status).toBe(200);
    const updated = await patchRes.json();
    expect(updated.seo.title).toBe("Contact Us | Updated");
    expect(updated.seo.twitterCard).toBe("summary");
  });

  it("rejects SEO image references to missing assets on update", async () => {
    const createRes = await jsonRequest(handler, "POST", "/api/records", {
      modelApiKey: "page",
      data: {
        title: "Needs Update",
        seo: { title: "Needs Update | Example" },
      },
    });
    const record = await createRes.json();

    const patchRes = await jsonRequest(handler, "PATCH", `/api/records/${record.id}`, {
      modelApiKey: "page",
      data: {
        seo: {
          title: "Needs Update | Example",
          image: "01NONEXISTENTASSET0000000000",
        },
      },
    });

    expect(patchRes.status).toBe(400);
    expect(await patchRes.text()).toContain("Asset(s) not found for field 'seo': 01NONEXISTENTASSET0000000000");
  });
});
