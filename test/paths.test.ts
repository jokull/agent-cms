import { describe, it, expect, beforeEach } from "vitest";
import { createTestApp, jsonRequest } from "./app-helpers.js";

async function json(res: Promise<Response>) {
  const r = await res;
  return r.json();
}

describe("Canonical Path Resolution", () => {
  let handler: (req: Request) => Promise<Response>;

  beforeEach(async () => {
    ({ handler } = createTestApp());
  });

  it("resolves simple {slug} template", async () => {
    // Create model with canonical_path_template
    const model = await json(
      jsonRequest(handler, "POST", "/api/models", {
        name: "Post",
        apiKey: "post",
        canonicalPathTemplate: "/blog/{slug}",
      }),
    );
    await jsonRequest(handler, "POST", `/api/models/${model.id}/fields`, {
      label: "Slug",
      apiKey: "slug",
      fieldType: "slug",
    });

    // Create and publish two records
    const rec1 = await json(
      jsonRequest(handler, "POST", "/api/records", {
        modelApiKey: "post",
        data: { slug: "first-post" },
      }),
    );
    const rec2 = await json(
      jsonRequest(handler, "POST", "/api/records", {
        modelApiKey: "post",
        data: { slug: "second-post" },
      }),
    );
    // Create a draft (should be excluded)
    await jsonRequest(handler, "POST", "/api/records", {
      modelApiKey: "post",
      data: { slug: "draft-post" },
    });

    await handler(
      new Request(
        `http://localhost/api/records/${rec1.id}/publish?modelApiKey=post`,
        { method: "POST" },
      ),
    );
    await handler(
      new Request(
        `http://localhost/api/records/${rec2.id}/publish?modelApiKey=post`,
        { method: "POST" },
      ),
    );

    const res = await handler(
      new Request("http://localhost/paths/post"),
    );
    expect(res.status).toBe(200);
    const entries = await res.json();
    expect(entries).toHaveLength(2);

    const paths = entries.map((e: { path: string }) => e.path).sort();
    expect(paths).toEqual(["/blog/first-post", "/blog/second-post"]);

    for (const entry of entries) {
      expect(entry.id).toBeTruthy();
      expect(entry.lastmod).toBeTruthy();
    }
  });

  it("resolves nested {category.slug} template via link traversal", async () => {
    // Create category model
    const catModel = await json(
      jsonRequest(handler, "POST", "/api/models", {
        name: "Category",
        apiKey: "category",
      }),
    );
    await jsonRequest(handler, "POST", `/api/models/${catModel.id}/fields`, {
      label: "Slug",
      apiKey: "slug",
      fieldType: "slug",
    });

    // Create post model with link to category
    const postModel = await json(
      jsonRequest(handler, "POST", "/api/models", {
        name: "Post",
        apiKey: "post",
        canonicalPathTemplate: "/blog/{category.slug}/{slug}",
      }),
    );
    await jsonRequest(handler, "POST", `/api/models/${postModel.id}/fields`, {
      label: "Slug",
      apiKey: "slug",
      fieldType: "slug",
    });
    await jsonRequest(handler, "POST", `/api/models/${postModel.id}/fields`, {
      label: "Category",
      apiKey: "category",
      fieldType: "link",
      validators: { item_item_type: ["category"] },
    });

    // Create category record
    const cat = await json(
      jsonRequest(handler, "POST", "/api/records", {
        modelApiKey: "category",
        data: { slug: "tech" },
      }),
    );
    await handler(
      new Request(
        `http://localhost/api/records/${cat.id}/publish?modelApiKey=category`,
        { method: "POST" },
      ),
    );

    // Create post linked to category
    const post = await json(
      jsonRequest(handler, "POST", "/api/records", {
        modelApiKey: "post",
        data: { slug: "hello-world", category: cat.id },
      }),
    );
    await handler(
      new Request(
        `http://localhost/api/records/${post.id}/publish?modelApiKey=post`,
        { method: "POST" },
      ),
    );

    const res = await handler(new Request("http://localhost/paths/post"));
    const entries = await res.json();
    expect(entries).toHaveLength(1);
    expect(entries[0].path).toBe("/blog/tech/hello-world");
  });

  it("leaves unresolvable tokens as {token} when link is null", async () => {
    const catModel = await json(
      jsonRequest(handler, "POST", "/api/models", {
        name: "Category",
        apiKey: "category",
      }),
    );
    await jsonRequest(handler, "POST", `/api/models/${catModel.id}/fields`, {
      label: "Slug",
      apiKey: "slug",
      fieldType: "slug",
    });

    const postModel = await json(
      jsonRequest(handler, "POST", "/api/models", {
        name: "Post",
        apiKey: "post",
        canonicalPathTemplate: "/blog/{category.slug}/{slug}",
      }),
    );
    await jsonRequest(handler, "POST", `/api/models/${postModel.id}/fields`, {
      label: "Slug",
      apiKey: "slug",
      fieldType: "slug",
    });
    await jsonRequest(handler, "POST", `/api/models/${postModel.id}/fields`, {
      label: "Category",
      apiKey: "category",
      fieldType: "link",
      validators: { item_item_type: ["category"] },
    });

    // Create post WITHOUT a category link
    const post = await json(
      jsonRequest(handler, "POST", "/api/records", {
        modelApiKey: "post",
        data: { slug: "orphan-post" },
      }),
    );
    await handler(
      new Request(
        `http://localhost/api/records/${post.id}/publish?modelApiKey=post`,
        { method: "POST" },
      ),
    );

    const res = await handler(new Request("http://localhost/paths/post"));
    const entries = await res.json();
    expect(entries).toHaveLength(1);
    expect(entries[0].path).toBe("/blog/{category.slug}/orphan-post");
  });

  it("returns error for model without canonical_path_template", async () => {
    await jsonRequest(handler, "POST", "/api/models", {
      name: "Page",
      apiKey: "page",
    });

    const res = await handler(new Request("http://localhost/paths/page"));
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toContain("canonical_path_template");
  });

  it("resolves deep 3-level nesting", async () => {
    // grandparent model
    const gpModel = await json(
      jsonRequest(handler, "POST", "/api/models", {
        name: "Section",
        apiKey: "section",
      }),
    );
    await jsonRequest(handler, "POST", `/api/models/${gpModel.id}/fields`, {
      label: "Slug",
      apiKey: "slug",
      fieldType: "slug",
    });

    // parent model with link to section
    const catModel = await json(
      jsonRequest(handler, "POST", "/api/models", {
        name: "Category",
        apiKey: "category",
      }),
    );
    await jsonRequest(handler, "POST", `/api/models/${catModel.id}/fields`, {
      label: "Slug",
      apiKey: "slug",
      fieldType: "slug",
    });
    await jsonRequest(handler, "POST", `/api/models/${catModel.id}/fields`, {
      label: "Section",
      apiKey: "section",
      fieldType: "link",
      validators: { item_item_type: ["section"] },
    });

    // post model with link to category
    const postModel = await json(
      jsonRequest(handler, "POST", "/api/models", {
        name: "Post",
        apiKey: "post",
        canonicalPathTemplate: "/{category.section.slug}/{category.slug}/{slug}",
      }),
    );
    await jsonRequest(handler, "POST", `/api/models/${postModel.id}/fields`, {
      label: "Slug",
      apiKey: "slug",
      fieldType: "slug",
    });
    await jsonRequest(handler, "POST", `/api/models/${postModel.id}/fields`, {
      label: "Category",
      apiKey: "category",
      fieldType: "link",
      validators: { item_item_type: ["category"] },
    });

    // Create records bottom-up
    const section = await json(
      jsonRequest(handler, "POST", "/api/records", {
        modelApiKey: "section",
        data: { slug: "engineering" },
      }),
    );
    await handler(
      new Request(
        `http://localhost/api/records/${section.id}/publish?modelApiKey=section`,
        { method: "POST" },
      ),
    );

    const cat = await json(
      jsonRequest(handler, "POST", "/api/records", {
        modelApiKey: "category",
        data: { slug: "backend", section: section.id },
      }),
    );
    await handler(
      new Request(
        `http://localhost/api/records/${cat.id}/publish?modelApiKey=category`,
        { method: "POST" },
      ),
    );

    const post = await json(
      jsonRequest(handler, "POST", "/api/records", {
        modelApiKey: "post",
        data: { slug: "effect-patterns", category: cat.id },
      }),
    );
    await handler(
      new Request(
        `http://localhost/api/records/${post.id}/publish?modelApiKey=post`,
        { method: "POST" },
      ),
    );

    const res = await handler(new Request("http://localhost/paths/post"));
    const entries = await res.json();
    expect(entries).toHaveLength(1);
    expect(entries[0].path).toBe("/engineering/backend/effect-patterns");
  });
});
