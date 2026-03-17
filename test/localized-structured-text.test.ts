import { describe, it, expect, beforeEach } from "vitest";
import { createTestApp, jsonRequest, gqlQuery } from "./app-helpers.js";

describe("Localized StructuredText", () => {
  let handler: (req: Request) => Promise<Response>;

  beforeEach(async () => {
    ({ handler } = createTestApp());

    const enRes = await jsonRequest(handler, "POST", "/api/locales", { code: "en", position: 0 });
    const en = await enRes.json();
    await jsonRequest(handler, "POST", "/api/locales", { code: "is", position: 1, fallbackLocaleId: en.id });
    await jsonRequest(handler, "POST", "/api/locales", { code: "fr", position: 2, fallbackLocaleId: en.id });

    const heroRes = await jsonRequest(handler, "POST", "/api/models", {
      name: "Hero Section", apiKey: "hero_section", isBlock: true,
    });
    const hero = await heroRes.json();
    await jsonRequest(handler, "POST", `/api/models/${hero.id}/fields`, {
      label: "Headline", apiKey: "headline", fieldType: "string",
    });

    const pageRes = await jsonRequest(handler, "POST", "/api/models", { name: "Page", apiKey: "page" });
    const page = await pageRes.json();
    await jsonRequest(handler, "POST", `/api/models/${page.id}/fields`, {
      label: "Title", apiKey: "title", fieldType: "string", localized: true,
    });
    await jsonRequest(handler, "POST", `/api/models/${page.id}/fields`, {
      label: "Body",
      apiKey: "body",
      fieldType: "structured_text",
      localized: true,
      validators: { structured_text_blocks: ["hero_section"] },
    });
  });

  it("resolves different block trees per locale in draft mode", async () => {
    const blockId = "shared_block";

    const createRes = await jsonRequest(handler, "POST", "/api/records", {
      modelApiKey: "page",
      data: {
        title: { en: "Hello", is: "Halló" },
        body: {
          en: {
            value: {
              schema: "dast",
              document: {
                type: "root",
                children: [{ type: "block", item: blockId }],
              },
            },
            blocks: {
              [blockId]: { _type: "hero_section", headline: "English Hero" },
            },
          },
          is: {
            value: {
              schema: "dast",
              document: {
                type: "root",
                children: [{ type: "block", item: blockId }],
              },
            },
            blocks: {
              [blockId]: { _type: "hero_section", headline: "Icelandic Hero" },
            },
          },
        },
      },
    });

    expect(createRes.status).toBe(201);

    const enResult = await gqlQuery(handler, `{
      allPages(locale: en) {
        title
        body {
          blocks {
            __typename
            ... on HeroSectionRecord { id headline }
          }
        }
      }
    }`);
    expect(enResult.errors).toBeUndefined();
    expect(enResult.data.allPages[0].title).toBe("Hello");
    expect(enResult.data.allPages[0].body.blocks[0].headline).toBe("English Hero");

    const isResult = await gqlQuery(handler, `{
      allPages(locale: is) {
        title
        body {
          blocks {
            __typename
            ... on HeroSectionRecord { id headline }
          }
        }
      }
    }`);
    expect(isResult.errors).toBeUndefined();
    expect(isResult.data.allPages[0].title).toBe("Halló");
    expect(isResult.data.allPages[0].body.blocks[0].headline).toBe("Icelandic Hero");

    const fallbackResult = await gqlQuery(handler, `{
      allPages(locale: fr, fallbackLocales: [is, en]) {
        body {
          blocks {
            ... on HeroSectionRecord { headline }
          }
        }
      }
    }`);
    expect(fallbackResult.errors).toBeUndefined();
    expect(fallbackResult.data.allPages[0].body.blocks[0].headline).toBe("Icelandic Hero");
  });

  it("materializes localized StructuredText correctly in published snapshots", async () => {
    const recordRes = await jsonRequest(handler, "POST", "/api/records", {
      modelApiKey: "page",
      data: {
        title: { en: "Published", is: "Birt" },
        body: {
          en: {
            value: {
              schema: "dast",
              document: {
                type: "root",
                children: [{ type: "block", item: "hero_en" }],
              },
            },
            blocks: {
              hero_en: { _type: "hero_section", headline: "Published English Hero" },
            },
          },
          is: {
            value: {
              schema: "dast",
              document: {
                type: "root",
                children: [{ type: "block", item: "hero_is" }],
              },
            },
            blocks: {
              hero_is: { _type: "hero_section", headline: "Birt Hetja" },
            },
          },
        },
      },
    });
    const record = await recordRes.json();

    const publishRes = await jsonRequest(handler, "POST", `/api/records/${record.id}/publish?modelApiKey=page`);
    expect(publishRes.status).toBe(200);

    const enResult = await gqlQuery(handler, `{
      allPages(locale: en) {
        body { blocks { ... on HeroSectionRecord { headline } } }
      }
    }`, undefined, { includeDrafts: false });
    expect(enResult.errors).toBeUndefined();
    expect(enResult.data.allPages[0].body.blocks[0].headline).toBe("Published English Hero");

    const isResult = await gqlQuery(handler, `{
      allPages(locale: is) {
        body { blocks { ... on HeroSectionRecord { headline } } }
      }
    }`, undefined, { includeDrafts: false });
    expect(isResult.errors).toBeUndefined();
    expect(isResult.data.allPages[0].body.blocks[0].headline).toBe("Birt Hetja");
  });
});
