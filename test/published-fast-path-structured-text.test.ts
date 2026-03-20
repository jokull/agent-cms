import { beforeEach, describe, expect, it } from "vitest";
import { createPublishedFastPath } from "../src/graphql/published-fast-path.js";
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
});
