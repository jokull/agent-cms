import { beforeEach, describe, expect, it } from "vitest";
import { createPublishedFastPath } from "../src/graphql/published-fast-path.js";
import { createGraphQLHandler } from "../src/graphql/handler.js";
import { createTestApp, gqlQuery, jsonRequest } from "./app-helpers.js";
import Database from "better-sqlite3";

describe("Published fast path StructuredText", () => {
  let handler: (req: Request) => Promise<Response>;
  let sqlLayer: ReturnType<typeof createTestApp>["sqlLayer"];

  beforeEach(async () => {
    ({ handler, sqlLayer } = createTestApp());
  });

  it("matches published GraphQL for nested typed blocks with links and media", async () => {
    const authorModelRes = await jsonRequest(handler, "POST", "/api/models", {
      name: "Author", apiKey: "author",
    });
    const authorModel = await authorModelRes.json();
    await jsonRequest(handler, "POST", `/api/models/${authorModel.id}/fields`, {
      label: "Name", apiKey: "name", fieldType: "string",
    });

    const authorRecordRes = await jsonRequest(handler, "POST", "/api/records", {
      modelApiKey: "author",
      data: { name: "Jane Doe" },
    });
    const authorRecord = await authorRecordRes.json();
    await handler(new Request(`http://localhost/api/records/${authorRecord.id}/publish?modelApiKey=author`, { method: "POST" }));

    const assetRes = await jsonRequest(handler, "POST", "/api/assets", {
      filename: "hero.jpg",
      mimeType: "image/jpeg",
      size: 50000,
      width: 1200,
      height: 800,
    });
    const asset = await assetRes.json();

    const venueModelRes = await jsonRequest(handler, "POST", "/api/models", {
      name: "Venue", apiKey: "venue", isBlock: true,
    });
    const venueModel = await venueModelRes.json();
    await jsonRequest(handler, "POST", `/api/models/${venueModel.id}/fields`, {
      label: "Name", apiKey: "name", fieldType: "string",
    });
    await jsonRequest(handler, "POST", `/api/models/${venueModel.id}/fields`, {
      label: "Location", apiKey: "location", fieldType: "lat_lon",
    });

    const sectionModelRes = await jsonRequest(handler, "POST", "/api/models", {
      name: "Section", apiKey: "section", isBlock: true,
    });
    const sectionModel = await sectionModelRes.json();
    await jsonRequest(handler, "POST", `/api/models/${sectionModel.id}/fields`, {
      label: "Heading", apiKey: "heading", fieldType: "string",
    });
    await jsonRequest(handler, "POST", `/api/models/${sectionModel.id}/fields`, {
      label: "Author", apiKey: "author", fieldType: "link",
      validators: { item_item_type: ["author"] },
    });
    await jsonRequest(handler, "POST", `/api/models/${sectionModel.id}/fields`, {
      label: "Image", apiKey: "image", fieldType: "media",
    });
    await jsonRequest(handler, "POST", `/api/models/${sectionModel.id}/fields`, {
      label: "Body", apiKey: "body", fieldType: "structured_text",
      validators: { structured_text_blocks: ["venue"] },
    });

    const postModelRes = await jsonRequest(handler, "POST", "/api/models", {
      name: "Post", apiKey: "post",
    });
    const postModel = await postModelRes.json();
    await jsonRequest(handler, "POST", `/api/models/${postModel.id}/fields`, {
      label: "Title", apiKey: "title", fieldType: "string",
    });
    await jsonRequest(handler, "POST", `/api/models/${postModel.id}/fields`, {
      label: "Content", apiKey: "content", fieldType: "structured_text",
      validators: { structured_text_blocks: ["section"] },
    });

    const venueBlockId = "01FASTPATHVENUE01";
    const sectionBlockId = "01FASTPATHSECT01";

    const postRes = await jsonRequest(handler, "POST", "/api/records", {
      modelApiKey: "post",
      data: {
        title: "Published Fast Path",
        content: {
          value: {
            schema: "dast",
            document: {
              type: "root",
              children: [{ type: "block", item: sectionBlockId }],
            },
          },
          blocks: {
            [sectionBlockId]: {
              _type: "section",
              heading: "Downtown",
              author: authorRecord.id,
              image: asset.id,
              body: {
                value: {
                  schema: "dast",
                  document: {
                    type: "root",
                    children: [{ type: "block", item: venueBlockId }],
                  },
                },
                blocks: {
                  [venueBlockId]: {
                    _type: "venue",
                    name: "Grillid",
                    location: { latitude: 64.1417, longitude: -21.9266 },
                  },
                },
              },
            },
          },
        },
      },
    });
    const post = await postRes.json();
    await handler(new Request(`http://localhost/api/records/${post.id}/publish?modelApiKey=post`, { method: "POST" }));

    const query = `{
      allPosts {
        title
        content {
          value
          blocks {
            __typename
            ... on SectionRecord {
              id
              heading
              author { name }
              image { id filename url }
              body {
                value
                blocks {
                  __typename
                  ... on VenueRecord {
                    id
                    name
                    location { latitude longitude }
                  }
                }
              }
            }
          }
        }
      }
    }`;

    const fastPath = createPublishedFastPath(sqlLayer, { assetBaseUrl: "" });
    const fastPathResult = await fastPath.tryExecute({ query }, { includeDrafts: false, excludeInvalid: false });
    const graphqlResult = await gqlQuery(handler, query, undefined, { includeDrafts: false });

    expect(fastPathResult).not.toBeNull();
    expect(graphqlResult.errors).toBeUndefined();
    expect(fastPathResult?.response).toEqual({ data: graphqlResult.data });
  });

  it("bulk-loads repeated linked records across the whole published tree", async () => {
    const tracedStatements: string[] = [];
    const originalPrepare = Database.prototype.prepare;
    Database.prototype.prepare = function patchedPrepare(sqlText: string, ...rest: unknown[]) {
      const statement = originalPrepare.call(this, sqlText, ...rest);
      const originalAll = statement.all;
      statement.all = function patchedAll(...params: unknown[]) {
        tracedStatements.push(`${sqlText} :: ${JSON.stringify(params)}`);
        return originalAll.apply(this, params);
      };
      return statement;
    };

    try {
      const authorModelRes = await jsonRequest(handler, "POST", "/api/models", {
        name: "Author", apiKey: "author",
      });
      const authorModel = await authorModelRes.json();
      await jsonRequest(handler, "POST", `/api/models/${authorModel.id}/fields`, {
        label: "Name", apiKey: "name", fieldType: "string",
      });

      const authorRecordRes = await jsonRequest(handler, "POST", "/api/records", {
        modelApiKey: "author",
        data: { name: "Jane Doe" },
      });
      const authorRecord = await authorRecordRes.json();
      await handler(new Request(`http://localhost/api/records/${authorRecord.id}/publish?modelApiKey=author`, { method: "POST" }));

      const sectionModelRes = await jsonRequest(handler, "POST", "/api/models", {
        name: "Section", apiKey: "section", isBlock: true,
      });
      const sectionModel = await sectionModelRes.json();
      await jsonRequest(handler, "POST", `/api/models/${sectionModel.id}/fields`, {
        label: "Heading", apiKey: "heading", fieldType: "string",
      });
      await jsonRequest(handler, "POST", `/api/models/${sectionModel.id}/fields`, {
        label: "Author", apiKey: "author", fieldType: "link",
        validators: { item_item_type: ["author"] },
      });

      const postModelRes = await jsonRequest(handler, "POST", "/api/models", {
        name: "Post", apiKey: "post",
      });
      const postModel = await postModelRes.json();
      await jsonRequest(handler, "POST", `/api/models/${postModel.id}/fields`, {
        label: "Author", apiKey: "author", fieldType: "link",
        validators: { item_item_type: ["author"] },
      });
      await jsonRequest(handler, "POST", `/api/models/${postModel.id}/fields`, {
        label: "Content", apiKey: "content", fieldType: "structured_text",
        validators: { structured_text_blocks: ["section"] },
      });

      const sectionBlockId = "01FASTPATHSECT01";
      const postRes = await jsonRequest(handler, "POST", "/api/records", {
        modelApiKey: "post",
        data: {
          author: authorRecord.id,
          content: {
            value: {
              schema: "dast",
              document: {
                type: "root",
                children: [{ type: "block", item: sectionBlockId }],
              },
            },
            blocks: {
              [sectionBlockId]: {
                _type: "section",
                heading: "Downtown",
                author: authorRecord.id,
              },
            },
          },
        },
      });
      const post = await postRes.json();
      await handler(new Request(`http://localhost/api/records/${post.id}/publish?modelApiKey=post`, { method: "POST" }));

      const fastPath = createPublishedFastPath(sqlLayer, { assetBaseUrl: "" });
      tracedStatements.length = 0;
      const result = await fastPath.tryExecute({
        query: `{
          allPosts {
            author { id name }
            content {
              blocks {
                ... on SectionRecord {
                  author { id name }
                }
              }
            }
          }
        }`,
      }, { includeDrafts: false, excludeInvalid: false });

      expect(result).not.toBeNull();
      const authorQueries = tracedStatements.filter((statement) => statement.includes('SELECT * FROM "content_author" WHERE id IN (?)'));
      expect(authorQueries).toHaveLength(1);
    } finally {
      Database.prototype.prepare = originalPrepare;
    }
  });

  it("bulk-loads repeated assets once across recursive roots", async () => {
    const tracedStatements: string[] = [];
    const originalPrepare = Database.prototype.prepare;
    Database.prototype.prepare = function patchedPrepare(sqlText: string, ...rest: unknown[]) {
      const statement = originalPrepare.call(this, sqlText, ...rest);
      const originalAll = statement.all;
      statement.all = function patchedAll(...params: unknown[]) {
        tracedStatements.push(`${sqlText} :: ${JSON.stringify(params)}`);
        return originalAll.apply(this, params);
      };
      return statement;
    };

    try {
      const assetRes = await jsonRequest(handler, "POST", "/api/assets", {
        filename: "hero.jpg",
        mimeType: "image/jpeg",
        size: 50000,
        width: 1200,
        height: 800,
      });
      const asset = await assetRes.json();

      const imageBlockModelRes = await jsonRequest(handler, "POST", "/api/models", {
        name: "Image Block", apiKey: "image_block", isBlock: true,
      });
      const imageBlockModel = await imageBlockModelRes.json();
      await jsonRequest(handler, "POST", `/api/models/${imageBlockModel.id}/fields`, {
        label: "image", apiKey: "image", fieldType: "media",
      });

      const postModelRes = await jsonRequest(handler, "POST", "/api/models", {
        name: "Post", apiKey: "post",
      });
      const postModel = await postModelRes.json();
      await jsonRequest(handler, "POST", `/api/models/${postModel.id}/fields`, {
        label: "content", apiKey: "content", fieldType: "structured_text",
        validators: { structured_text_blocks: ["image_block"] },
      });

      const editorialModelRes = await jsonRequest(handler, "POST", "/api/models", {
        name: "Editorial", apiKey: "editorial",
      });
      const editorialModel = await editorialModelRes.json();
      await jsonRequest(handler, "POST", `/api/models/${editorialModel.id}/fields`, {
        label: "content", apiKey: "content", fieldType: "structured_text",
        validators: { structured_text_blocks: ["image_block"] },
      });

      for (const [modelApiKey, blockId] of [
        ["post", "01FASTPATHIMG11"],
        ["editorial", "01FASTPATHIMG12"],
      ] as const) {
        const recordRes = await jsonRequest(handler, "POST", "/api/records", {
          modelApiKey,
          data: {
            content: {
              value: {
                schema: "dast",
                document: {
                  type: "root",
                  children: [{ type: "block", item: blockId }],
                },
              },
              blocks: {
                [blockId]: {
                  _type: "image_block",
                  image: asset.id,
                },
              },
            },
          },
        });
        const record = await recordRes.json();
        await handler(new Request(`http://localhost/api/records/${record.id}/publish?modelApiKey=${modelApiKey}`, { method: "POST" }));
      }

      const fastPath = createPublishedFastPath(sqlLayer, { assetBaseUrl: "" });
      tracedStatements.length = 0;
      const result = await fastPath.tryExecute({
        query: `{
          allPosts {
            content {
              blocks {
                ... on ImageBlockRecord {
                  image { id url }
                }
              }
            }
          }
          allEditorials {
            content {
              blocks {
                ... on ImageBlockRecord {
                  image { id url }
                }
              }
            }
          }
        }`,
      }, { includeDrafts: false, excludeInvalid: false });

      expect(result).not.toBeNull();
      const assetQueries = tracedStatements.filter((statement) => statement.includes("SELECT * FROM assets WHERE id IN (?)"));
      expect(assetQueries).toHaveLength(1);
      expect(result?.metrics.byCategory.root?.statementCount).toBe(1);
    } finally {
      Database.prototype.prepare = originalPrepare;
    }
  });

  it("bails out for unsupported StructuredText sub-selections", async () => {
    const imageBlockModelRes = await jsonRequest(handler, "POST", "/api/models", {
      name: "Image Block", apiKey: "image_block", isBlock: true,
    });
    const imageBlockModel = await imageBlockModelRes.json();
    await jsonRequest(handler, "POST", `/api/models/${imageBlockModel.id}/fields`, {
      label: "Image", apiKey: "image", fieldType: "media",
    });

    const postModelRes = await jsonRequest(handler, "POST", "/api/models", {
      name: "Post", apiKey: "post",
    });
    const postModel = await postModelRes.json();
    await jsonRequest(handler, "POST", `/api/models/${postModel.id}/fields`, {
      label: "Content", apiKey: "content", fieldType: "structured_text",
      validators: { structured_text_blocks: ["image_block"] },
    });

    const postRes = await jsonRequest(handler, "POST", "/api/records", {
      modelApiKey: "post",
      data: {
        content: {
          value: {
            schema: "dast",
            document: {
              type: "root",
              children: [{ type: "block", item: "01FASTPATHIMG01" }],
            },
          },
          blocks: {
            "01FASTPATHIMG01": {
              _type: "image_block",
              image: "asset_1",
            },
          },
        },
      },
    });
    const post = await postRes.json();
    await handler(new Request(`http://localhost/api/records/${post.id}/publish?modelApiKey=post`, { method: "POST" }));

    const fastPath = createPublishedFastPath(sqlLayer, { assetBaseUrl: "" });
    const result = await fastPath.tryExecute({
      query: `{
        allPosts {
          content {
            blocks {
              ... on ImageBlockRecord {
                image {
                  responsiveImage { src }
                }
              }
            }
          }
        }
      }`,
    }, {
      includeDrafts: false,
      excludeInvalid: false,
    });

    expect(result).toBeNull();
  });

  it("emits publish-path SQL headers on fast-path hits", async () => {
    const settingsModelRes = await jsonRequest(handler, "POST", "/api/models", {
      name: "Site Settings", apiKey: "site_settings", singleton: true,
    });
    const settingsModel = await settingsModelRes.json();
    await jsonRequest(handler, "POST", `/api/models/${settingsModel.id}/fields`, {
      label: "Site Name", apiKey: "site_name", fieldType: "string",
    });
    const settingsRecordRes = await jsonRequest(handler, "POST", "/api/records", {
      modelApiKey: "site_settings",
      data: { site_name: "Agent CMS" },
    });
    const settingsRecord = await settingsRecordRes.json();
    await handler(new Request(`http://localhost/api/records/${settingsRecord.id}/publish?modelApiKey=site_settings`, { method: "POST" }));

    const response = await handler(new Request("http://localhost/graphql", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ query: "{ siteSettings { siteName } }" }),
    }));
    const body = await response.json();

    expect(body).toEqual({ data: { siteSettings: { siteName: "Agent CMS" } } });
    expect(response.headers.get("X-Published-Fast-Path")).toBe("hit");
    expect(response.headers.get("X-Published-Fast-Path-Sql-Count")).toBeTruthy();
    expect(response.headers.get("X-Published-Fast-Path-Sql-Breakdown")).toContain("root:");
  });

  it("partially fast-paths supported roots during execute()", async () => {
    const settingsModelRes = await jsonRequest(handler, "POST", "/api/models", {
      name: "Site Settings", apiKey: "site_settings", singleton: true,
    });
    const settingsModel = await settingsModelRes.json();
    await jsonRequest(handler, "POST", `/api/models/${settingsModel.id}/fields`, {
      label: "Site Name", apiKey: "site_name", fieldType: "string",
    });
    const settingsRecordRes = await jsonRequest(handler, "POST", "/api/records", {
      modelApiKey: "site_settings",
      data: { site_name: "Agent CMS" },
    });
    const settingsRecord = await settingsRecordRes.json();
    await handler(new Request(`http://localhost/api/records/${settingsRecord.id}/publish?modelApiKey=site_settings`, { method: "POST" }));

    const assetRes = await jsonRequest(handler, "POST", "/api/assets", {
      filename: "hero.jpg",
      mimeType: "image/jpeg",
      size: 50000,
      width: 1200,
      height: 800,
    });
    const asset = await assetRes.json();

    const imageBlockModelRes = await jsonRequest(handler, "POST", "/api/models", {
      name: "Image Block", apiKey: "image_block", isBlock: true,
    });
    const imageBlockModel = await imageBlockModelRes.json();
    await jsonRequest(handler, "POST", `/api/models/${imageBlockModel.id}/fields`, {
      label: "Image", apiKey: "image", fieldType: "media",
    });

    const postModelRes = await jsonRequest(handler, "POST", "/api/models", {
      name: "Post", apiKey: "post",
    });
    const postModel = await postModelRes.json();
    await jsonRequest(handler, "POST", `/api/models/${postModel.id}/fields`, {
      label: "Content", apiKey: "content", fieldType: "structured_text",
      validators: { structured_text_blocks: ["image_block"] },
    });

    const postRes = await jsonRequest(handler, "POST", "/api/records", {
      modelApiKey: "post",
      data: {
        content: {
          value: {
            schema: "dast",
            document: {
              type: "root",
              children: [{ type: "block", item: "01FASTPATHIMG01" }],
            },
          },
          blocks: {
            "01FASTPATHIMG01": {
              _type: "image_block",
              image: asset.id,
            },
          },
        },
      },
    });
    const post = await postRes.json();
    await handler(new Request(`http://localhost/api/records/${post.id}/publish?modelApiKey=post`, { method: "POST" }));

    const graphql = createGraphQLHandler(sqlLayer, { assetBaseUrl: "" });
    const result = await graphql.execute(`{
      siteSettings { siteName }
      allPosts {
        content {
          blocks {
            ... on ImageBlockRecord {
              image {
                responsiveImage { src }
              }
            }
          }
        }
      }
    }`, undefined, { includeDrafts: false, excludeInvalid: false });

    expect(result.errors).toBeUndefined();
    expect((result.data as { siteSettings: { siteName: string } }).siteSettings.siteName).toBe("Agent CMS");
    expect((result.data as { allPosts: unknown[] }).allPosts).toHaveLength(1);
    expect(result._trace).toMatchObject({
      path: "partial",
      rootPaths: {
        siteSettings: "fast-path",
        allPosts: "yoga",
      },
    });
  });

  it("fast-paths the rvkfoodie-style homepage query during execute()", async () => {
    const homePageModelRes = await jsonRequest(handler, "POST", "/api/models", {
      name: "Home Page", apiKey: "home_page", singleton: true,
    });
    const homePageModel = await homePageModelRes.json();
    for (const apiKey of [
      "headline",
      "headline_emphasis",
      "subtext",
      "bundle_title",
      "bundle_description",
      "bundle_price",
      "bundle_gumroad_url",
      "author_blurb",
    ]) {
      await jsonRequest(handler, "POST", `/api/models/${homePageModel.id}/fields`, {
        label: apiKey,
        apiKey,
        fieldType: "string",
      });
    }
    const homePageRecordRes = await jsonRequest(handler, "POST", "/api/records", {
      modelApiKey: "home_page",
      data: {
        headline: "Reykjavik",
        headline_emphasis: "Foodie",
        subtext: "Guide",
        bundle_title: "Bundle",
        bundle_description: "Bundle Description",
        bundle_price: "59",
        bundle_gumroad_url: "https://example.com/bundle",
        author_blurb: "Author blurb",
      },
    });
    const homePageRecord = await homePageRecordRes.json();
    await handler(new Request(`http://localhost/api/records/${homePageRecord.id}/publish?modelApiKey=home_page`, { method: "POST" }));

    const assetRes = await jsonRequest(handler, "POST", "/api/assets", {
      filename: "hero.jpg",
      mimeType: "image/jpeg",
      size: 50000,
      width: 1200,
      height: 800,
      alt: "Hero image",
    });
    const asset = await assetRes.json();

    const venueModelRes = await jsonRequest(handler, "POST", "/api/models", {
      name: "Venue", apiKey: "venue", isBlock: true,
    });
    const venueModel = await venueModelRes.json();
    for (const [apiKey, fieldType] of [
      ["name", "string"],
      ["address", "string"],
      ["description", "text"],
      ["note", "text"],
      ["time", "string"],
      ["opening_hours", "text"],
      ["google_maps_url", "string"],
      ["website", "string"],
      ["phone", "string"],
      ["best_of_award", "boolean"],
      ["grapevine_url", "string"],
    ] as const) {
      await jsonRequest(handler, "POST", `/api/models/${venueModel.id}/fields`, {
        label: apiKey,
        apiKey,
        fieldType,
      });
    }
    await jsonRequest(handler, "POST", `/api/models/${venueModel.id}/fields`, {
      label: "is_free",
      apiKey: "is_free",
      fieldType: "boolean",
    });
    await jsonRequest(handler, "POST", `/api/models/${venueModel.id}/fields`, {
      label: "location",
      apiKey: "location",
      fieldType: "lat_lon",
    });
    await jsonRequest(handler, "POST", `/api/models/${venueModel.id}/fields`, {
      label: "image",
      apiKey: "image",
      fieldType: "media",
    });

    const sectionModelRes = await jsonRequest(handler, "POST", "/api/models", {
      name: "Section", apiKey: "section", isBlock: true,
    });
    const sectionModel = await sectionModelRes.json();
    await jsonRequest(handler, "POST", `/api/models/${sectionModel.id}/fields`, {
      label: "title",
      apiKey: "title",
      fieldType: "string",
    });
    await jsonRequest(handler, "POST", `/api/models/${sectionModel.id}/fields`, {
      label: "venues",
      apiKey: "venues",
      fieldType: "structured_text",
      validators: { structured_text_blocks: ["venue"] },
    });

    const textBlockModelRes = await jsonRequest(handler, "POST", "/api/models", {
      name: "Text Block", apiKey: "text_block", isBlock: true,
    });
    const textBlockModel = await textBlockModelRes.json();
    await jsonRequest(handler, "POST", `/api/models/${textBlockModel.id}/fields`, {
      label: "heading",
      apiKey: "heading",
      fieldType: "string",
    });
    await jsonRequest(handler, "POST", `/api/models/${textBlockModel.id}/fields`, {
      label: "is_free",
      apiKey: "is_free",
      fieldType: "boolean",
    });
    await jsonRequest(handler, "POST", `/api/models/${textBlockModel.id}/fields`, {
      label: "content",
      apiKey: "content",
      fieldType: "structured_text",
    });

    const imageBlockModelRes = await jsonRequest(handler, "POST", "/api/models", {
      name: "Image Block", apiKey: "image_block", isBlock: true,
    });
    const imageBlockModel = await imageBlockModelRes.json();
    await jsonRequest(handler, "POST", `/api/models/${imageBlockModel.id}/fields`, {
      label: "image",
      apiKey: "image",
      fieldType: "media",
    });
    await jsonRequest(handler, "POST", `/api/models/${imageBlockModel.id}/fields`, {
      label: "caption",
      apiKey: "caption",
      fieldType: "string",
    });

    const guideModelRes = await jsonRequest(handler, "POST", "/api/models", {
      name: "Guide", apiKey: "guide",
    });
    const guideModel = await guideModelRes.json();
    for (const [apiKey, fieldType] of [
      ["title", "string"],
      ["slug", "slug"],
      ["subtitle", "string"],
      ["description", "text"],
      ["price", "integer"],
      ["gumroad_product_id", "string"],
      ["gumroad_url", "string"],
      ["google_maps_url", "string"],
    ] as const) {
      await jsonRequest(handler, "POST", `/api/models/${guideModel.id}/fields`, {
        label: apiKey,
        apiKey,
        fieldType,
      });
    }
    await jsonRequest(handler, "POST", `/api/models/${guideModel.id}/fields`, {
      label: "intro",
      apiKey: "intro",
      fieldType: "structured_text",
    });
    await jsonRequest(handler, "POST", `/api/models/${guideModel.id}/fields`, {
      label: "content",
      apiKey: "content",
      fieldType: "structured_text",
      validators: { structured_text_blocks: ["section", "text_block"] },
    });

    const editorialModelRes = await jsonRequest(handler, "POST", "/api/models", {
      name: "Editorial", apiKey: "editorial",
    });
    const editorialModel = await editorialModelRes.json();
    for (const [apiKey, fieldType] of [
      ["title", "string"],
      ["slug", "slug"],
      ["excerpt", "text"],
      ["date", "date"],
    ] as const) {
      await jsonRequest(handler, "POST", `/api/models/${editorialModel.id}/fields`, {
        label: apiKey,
        apiKey,
        fieldType,
      });
    }
    await jsonRequest(handler, "POST", `/api/models/${editorialModel.id}/fields`, {
      label: "image",
      apiKey: "image",
      fieldType: "media",
    });
    await jsonRequest(handler, "POST", `/api/models/${editorialModel.id}/fields`, {
      label: "content",
      apiKey: "content",
      fieldType: "structured_text",
      validators: { structured_text_blocks: ["image_block"] },
    });

    const venueBlockId = "01FASTPATHVENUE02";
    const sectionBlockId = "01FASTPATHSECT02";
    const textBlockId = "01FASTPATHTEXT02";
    const imageBlockId = "01FASTPATHIMG02";

    const guideRecordRes = await jsonRequest(handler, "POST", "/api/records", {
      modelApiKey: "guide",
      data: {
        title: "Best Cheap Eats",
        slug: "best-cheap-eats",
        subtitle: "Subtitle",
        description: "Guide description",
        price: 19,
        gumroad_product_id: "gum-1",
        gumroad_url: "https://example.com/guide",
        google_maps_url: "https://maps.example.com/guide",
        intro: {
          value: {
            schema: "dast",
            document: {
              type: "root",
              children: [{ type: "paragraph", children: [{ type: "span", value: "Intro" }] }],
            },
          },
          blocks: {},
        },
        content: {
          value: {
            schema: "dast",
            document: {
              type: "root",
              children: [
                { type: "block", item: sectionBlockId },
                { type: "block", item: textBlockId },
              ],
            },
          },
          blocks: {
            [sectionBlockId]: {
              _type: "section",
              title: "Center",
              venues: {
                value: {
                  schema: "dast",
                  document: {
                    type: "root",
                    children: [{ type: "block", item: venueBlockId }],
                  },
                },
                blocks: {
                  [venueBlockId]: {
                    _type: "venue",
                    name: "Grillid",
                    address: "Main street",
                    description: "Venue description",
                    note: "Bring friends",
                    time: "18:00",
                    is_free: true,
                    location: { latitude: 64.1417, longitude: -21.9266 },
                    opening_hours: "Daily",
                    google_maps_url: "https://maps.example.com/venue",
                    website: "https://example.com/venue",
                    phone: "555-0101",
                    best_of_award: true,
                    grapevine_url: "https://grapevine.is/venue",
                    image: asset.id,
                  },
                },
              },
            },
            [textBlockId]: {
              _type: "text_block",
              heading: "Notes",
              is_free: false,
              content: {
                value: {
                  schema: "dast",
                  document: {
                    type: "root",
                    children: [{ type: "paragraph", children: [{ type: "span", value: "Paid section" }] }],
                  },
                },
                blocks: {},
              },
            },
          },
        },
      },
    });
    const guideRecord = await guideRecordRes.json();
    await handler(new Request(`http://localhost/api/records/${guideRecord.id}/publish?modelApiKey=guide`, { method: "POST" }));

    const editorialRecordRes = await jsonRequest(handler, "POST", "/api/records", {
      modelApiKey: "editorial",
      data: {
        title: "Spring picks",
        slug: "spring-picks",
        excerpt: "Editorial excerpt",
        date: "2026-03-20",
        image: asset.id,
        content: {
          value: {
            schema: "dast",
            document: {
              type: "root",
              children: [{ type: "block", item: imageBlockId }],
            },
          },
          blocks: {
            [imageBlockId]: {
              _type: "image_block",
              image: asset.id,
              caption: "Caption",
            },
          },
        },
      },
    });
    const editorialRecord = await editorialRecordRes.json();
    await handler(new Request(`http://localhost/api/records/${editorialRecord.id}/publish?modelApiKey=editorial`, { method: "POST" }));

    const graphql = createGraphQLHandler(sqlLayer, { assetBaseUrl: "" });
    const result = await graphql.execute(`query HomePageData {
      homePage {
        id
        headline
        headlineEmphasis
        subtext
        bundleTitle
        bundleDescription
        bundlePrice
        bundleGumroadUrl
        authorBlurb
      }
      allGuides(orderBy: [price_DESC]) {
        id
        title
        slug
        subtitle
        description
        price
        gumroadProductId
        gumroadUrl
        googleMapsUrl
        intro { value }
        content {
          value
          blocks {
            __typename
            ... on SectionRecord {
              id
              title
              venues {
                value
                blocks {
                  __typename
                  ... on VenueRecord {
                    id
                    name
                    address
                    description
                    note
                    time
                    isFree
                    location { latitude longitude }
                    openingHours
                    googleMapsUrl
                    website
                    phone
                    bestOfAward
                    grapevineUrl
                    image { id url alt width height }
                  }
                }
              }
            }
            ... on TextBlockRecord {
              id
              heading
              isFree
              content { value }
            }
          }
        }
      }
      allEditorials(orderBy: [date_DESC]) {
        id
        title
        slug
        excerpt
        date
        image { id url alt width height }
        content {
          value
          blocks {
            __typename
            ... on ImageBlockRecord {
              id
              image { id url alt width height }
              caption
            }
          }
        }
      }
    }`, undefined, { includeDrafts: false, excludeInvalid: false });

    expect(result.errors).toBeUndefined();
    expect((result.data as { allGuides: unknown[] }).allGuides).toHaveLength(1);
    expect((result.data as { allEditorials: unknown[] }).allEditorials).toHaveLength(1);
    expect((result.data as { homePage: { headline: string } }).homePage.headline).toBe("Reykjavik");
    expect(result._trace).toMatchObject({
      path: "fast-path",
      rootPaths: {
        homePage: "fast-path",
        allGuides: "fast-path",
        allEditorials: "fast-path",
      },
    });
  });
});
