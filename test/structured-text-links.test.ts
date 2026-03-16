import { describe, it, expect, beforeEach } from "vitest";
import { createTestApp, jsonRequest, gqlQuery } from "./app-helpers.js";

describe("StructuredText links resolution (P6.7)", () => {
  let handler: (req: Request) => Promise<Response>;
  let authorId: string;
  let tagId: string;

  beforeEach(async () => {
    ({ handler } = createTestApp());

    // Create referenced models
    const authorModelRes = await jsonRequest(handler, "POST", "/api/models", { name: "Author", apiKey: "author" });
    const authorModel = await authorModelRes.json();
    await jsonRequest(handler, "POST", `/api/models/${authorModel.id}/fields`, {
      label: "Name", apiKey: "name", fieldType: "string",
    });

    const tagModelRes = await jsonRequest(handler, "POST", "/api/models", { name: "Tag", apiKey: "tag" });
    const tagModel = await tagModelRes.json();
    await jsonRequest(handler, "POST", `/api/models/${tagModel.id}/fields`, {
      label: "Label", apiKey: "label", fieldType: "string",
    });

    // Create the records that will be linked
    const authorRec = await (await jsonRequest(handler, "POST", "/api/records", {
      modelApiKey: "author", data: { name: "Alice" },
    })).json();
    authorId = authorRec.id;

    const tagRec = await (await jsonRequest(handler, "POST", "/api/records", {
      modelApiKey: "tag", data: { label: "GraphQL" },
    })).json();
    tagId = tagRec.id;

    // Create the article model with structured_text field
    const articleModelRes = await jsonRequest(handler, "POST", "/api/models", { name: "Article", apiKey: "article" });
    const articleModel = await articleModelRes.json();
    await jsonRequest(handler, "POST", `/api/models/${articleModel.id}/fields`, {
      label: "Title", apiKey: "title", fieldType: "string",
    });
    await jsonRequest(handler, "POST", `/api/models/${articleModel.id}/fields`, {
      label: "Content", apiKey: "content", fieldType: "structured_text",
    });
  });

  it("resolves itemLink references in StructuredText links array", async () => {
    // Create an article with DAST containing an itemLink to the author
    const dast = {
      schema: "dast",
      document: {
        type: "root",
        children: [
          {
            type: "paragraph",
            children: [
              { type: "span", value: "Written by " },
              {
                type: "itemLink",
                item: authorId,
                children: [{ type: "span", value: "Alice" }],
              },
            ],
          },
        ],
      },
    };

    await jsonRequest(handler, "POST", "/api/records", {
      modelApiKey: "article",
      data: { title: "My Article", content: { value: dast } },
    });

    const result = await gqlQuery(handler, `{
      allArticles {
        title
        content { value links }
      }
    }`, { includeDrafts: true });

    expect(result.errors).toBeUndefined();
    const article = result.data.allArticles[0];
    expect(article.content.links).toHaveLength(1);
    expect(article.content.links[0].id).toBe(authorId);
    expect(article.content.links[0].name).toBe("Alice");
    expect(article.content.links[0].__typename).toBe("AuthorRecord");
  });

  it("resolves inlineItem references in links array", async () => {
    const dast = {
      schema: "dast",
      document: {
        type: "root",
        children: [
          {
            type: "paragraph",
            children: [
              { type: "span", value: "Tagged: " },
              { type: "inlineItem", item: tagId },
            ],
          },
        ],
      },
    };

    await jsonRequest(handler, "POST", "/api/records", {
      modelApiKey: "article",
      data: { title: "Tagged Article", content: { value: dast } },
    });

    const result = await gqlQuery(handler, `{
      allArticles {
        content { value links }
      }
    }`, { includeDrafts: true });

    expect(result.errors).toBeUndefined();
    const article = result.data.allArticles[0];
    expect(article.content.links).toHaveLength(1);
    expect(article.content.links[0].id).toBe(tagId);
    expect(article.content.links[0].label).toBe("GraphQL");
    expect(article.content.links[0].__typename).toBe("TagRecord");
  });

  it("resolves multiple links from different models", async () => {
    const dast = {
      schema: "dast",
      document: {
        type: "root",
        children: [
          {
            type: "paragraph",
            children: [
              {
                type: "itemLink",
                item: authorId,
                children: [{ type: "span", value: "Alice" }],
              },
              { type: "span", value: " wrote about " },
              { type: "inlineItem", item: tagId },
            ],
          },
        ],
      },
    };

    await jsonRequest(handler, "POST", "/api/records", {
      modelApiKey: "article",
      data: { title: "Multi-link", content: { value: dast } },
    });

    const result = await gqlQuery(handler, `{
      allArticles {
        content { links }
      }
    }`, { includeDrafts: true });

    expect(result.errors).toBeUndefined();
    const links = result.data.allArticles[0].content.links;
    expect(links).toHaveLength(2);

    const authorLink = links.find((l: any) => l.__typename === "AuthorRecord");
    expect(authorLink).toBeDefined();
    expect(authorLink.name).toBe("Alice");

    const tagLink = links.find((l: any) => l.__typename === "TagRecord");
    expect(tagLink).toBeDefined();
    expect(tagLink.label).toBe("GraphQL");
  });

  it("returns empty links when no itemLink/inlineItem in DAST", async () => {
    const dast = {
      schema: "dast",
      document: {
        type: "root",
        children: [
          {
            type: "paragraph",
            children: [{ type: "span", value: "Plain text, no links." }],
          },
        ],
      },
    };

    await jsonRequest(handler, "POST", "/api/records", {
      modelApiKey: "article",
      data: { title: "No Links", content: { value: dast } },
    });

    const result = await gqlQuery(handler, `{
      allArticles {
        content { links }
      }
    }`, { includeDrafts: true });

    expect(result.errors).toBeUndefined();
    expect(result.data.allArticles[0].content.links).toEqual([]);
  });
});
