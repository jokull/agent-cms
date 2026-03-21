import { beforeEach, describe, expect, it } from "vitest";
import { createTestApp, gqlQuery, jsonRequest } from "./app-helpers.js";

type Handler = (req: Request) => Promise<Response>;

async function createModel(handler: Handler, payload: Record<string, unknown>) {
  const response = await jsonRequest(handler, "POST", "/api/models", payload);
  expect(response.status).toBeLessThan(300);
  return response.json() as Promise<{ id: string }>;
}

async function addField(handler: Handler, modelId: string, payload: Record<string, unknown>) {
  const response = await jsonRequest(handler, "POST", `/api/models/${modelId}/fields`, payload);
  expect(response.status).toBeLessThan(300);
}

async function createRecord(handler: Handler, modelApiKey: string, data: Record<string, unknown>) {
  const response = await jsonRequest(handler, "POST", "/api/records", { modelApiKey, data });
  expect(response.status).toBeLessThan(300);
  return response.json() as Promise<{ id: string }>;
}

async function publishRecord(handler: Handler, modelApiKey: string, id: string) {
  const response = await jsonRequest(handler, "POST", `/api/records/${id}/publish?modelApiKey=${modelApiKey}`);
  expect(response.status).toBeLessThan(300);
}

async function createAsset(handler: Handler, payload: Record<string, unknown>) {
  const response = await jsonRequest(handler, "POST", "/api/assets", payload);
  expect(response.status).toBeLessThan(300);
  return response.json() as Promise<{ id: string }>;
}

describe("GraphQL compatibility query shapes", () => {
  let handler: Handler;

  beforeEach(async () => {
    ({ handler } = createTestApp());

    const englishResponse = await jsonRequest(handler, "POST", "/api/locales", { code: "en", position: 0 });
    expect(englishResponse.status).toBeLessThan(300);
    const english = await englishResponse.json();

    const japaneseResponse = await jsonRequest(handler, "POST", "/api/locales", {
      code: "ja",
      position: 1,
      fallbackLocaleId: english.id,
    });
    expect(japaneseResponse.status).toBeLessThan(300);
  });

  it("supports locale + fallbackLocales on root queries", async () => {
    const article = await createModel(handler, { name: "Article", apiKey: "article" });
    await addField(handler, article.id, { label: "Title", apiKey: "title", fieldType: "string", localized: true });
    await addField(handler, article.id, { label: "Slug", apiKey: "slug", fieldType: "slug" });

    await createRecord(handler, "article", {
      title: { en: "English title", ja: "日本語タイトル" },
      slug: "english-title",
    });

    const result = await gqlQuery(handler, `
      query Article($locale: SiteLocale!, $slug: String!) {
        article(locale: $locale, fallbackLocales: en, filter: { slug: { eq: $slug } }) {
          __typename
          title
          slug
        }
      }
    `, { locale: "ja", slug: "english-title" });

    expect(result.errors).toBeUndefined();
    expect(result.data?.article.__typename).toBe("ArticleRecord");
    expect(result.data?.article.title).toBe("日本語タイトル");
  });

  it("supports _all<Field>Locales on localized fields", async () => {
    const article = await createModel(handler, { name: "Article", apiKey: "article" });
    await addField(handler, article.id, { label: "Title", apiKey: "title", fieldType: "string", localized: true });

    await createRecord(handler, "article", {
      title: { en: "Hello", ja: "こんにちは" },
    });

    const result = await gqlQuery(handler, `{
      allArticles {
        _allTitleLocales { locale value }
      }
    }`);

    expect(result.errors).toBeUndefined();
    expect(result.data?.allArticles[0]._allTitleLocales).toEqual([
      { locale: "en", value: "Hello" },
      { locale: "ja", value: "こんにちは" },
    ]);
  });

  it("supports _seoMetaTags on records", async () => {
    const article = await createModel(handler, { name: "Article", apiKey: "article" });
    await addField(handler, article.id, { label: "Title", apiKey: "title", fieldType: "string" });

    await createRecord(handler, "article", { title: "SEO Title" });

    const result = await gqlQuery(handler, `{
      allArticles { _seoMetaTags { tag attributes content } }
    }`);

    expect(result.errors).toBeUndefined();
    expect(result.data?.allArticles[0]._seoMetaTags.length).toBeGreaterThan(0);
  });

  it("supports responsiveImage with imgixParams shim", async () => {
    const post = await createModel(handler, { name: "Post", apiKey: "post" });
    await addField(handler, post.id, { label: "Title", apiKey: "title", fieldType: "string" });
    await addField(handler, post.id, { label: "Cover", apiKey: "cover", fieldType: "media" });

    const asset = await createAsset(handler, {
      filename: "hero.jpg",
      mimeType: "image/jpeg",
      size: 100000,
      width: 2400,
      height: 1600,
      alt: "Hero image",
    });

    await createRecord(handler, "post", { title: "Image Post", cover: asset.id });

    const result = await gqlQuery(handler, `{
      allPosts {
        cover {
          responsiveImage(imgixParams: { auto: format, fit: crop, w: 700, h: 420 }) {
            src
            width
            height
          }
        }
      }
    }`);

    expect(result.errors).toBeUndefined();
    expect(result.data?.allPosts[0].cover.responsiveImage.width).toBe(700);
    expect(result.data?.allPosts[0].cover.responsiveImage.height).toBe(420);
  });

  it("supports reverse relationships with pagination arguments", async () => {
    const location = await createModel(handler, { name: "Location", apiKey: "location" });
    await addField(handler, location.id, { label: "Name", apiKey: "name", fieldType: "string", localized: true });

    const guide = await createModel(handler, { name: "Guide", apiKey: "guide" });
    await addField(handler, guide.id, { label: "Title", apiKey: "title", fieldType: "string", localized: true });
    await addField(handler, guide.id, {
      label: "Location",
      apiKey: "location",
      fieldType: "link",
      validators: { item_item_type: ["location"] },
    });

    const locationRecord = await createRecord(handler, "location", {
      name: { en: "Tokyo", ja: "東京" },
    });

    for (let index = 1; index <= 5; index += 1) {
      await createRecord(handler, "guide", {
        title: { en: `Guide ${index}`, ja: `ガイド ${index}` },
        location: locationRecord.id,
      });
    }

    const result = await gqlQuery(handler, `
      query Location($id: ItemId!, $locale: SiteLocale!) {
        location(id: $id) {
          _allReferencingGuides(locale: $locale, fallbackLocales: en, first: 2, skip: 1) {
            title
          }
        }
      }
    `, { id: locationRecord.id, locale: "ja" });

    expect(result.errors).toBeUndefined();
    expect(result.data?.location._allReferencingGuides).toHaveLength(2);
  });

  it("supports a deep mixed query with reverse refs, block links, and responsiveImage", async () => {
    const person = await createModel(handler, { name: "Person", apiKey: "person" });
    await addField(handler, person.id, { label: "Name", apiKey: "name", fieldType: "string" });

    const location = await createModel(handler, { name: "Location", apiKey: "location" });
    await addField(handler, location.id, { label: "Name", apiKey: "name", fieldType: "string" });

    const imageBlock = await createModel(handler, { name: "Image Block", apiKey: "image_block", isBlock: true });
    await addField(handler, imageBlock.id, { label: "Image", apiKey: "image", fieldType: "media" });

    const quoteBlock = await createModel(handler, { name: "Quote Block", apiKey: "quote_block", isBlock: true });
    await addField(handler, quoteBlock.id, { label: "Text", apiKey: "text", fieldType: "string" });
    await addField(handler, quoteBlock.id, {
      label: "Author",
      apiKey: "author",
      fieldType: "link",
      validators: { item_item_type: ["person"] },
    });

    const guide = await createModel(handler, { name: "Guide", apiKey: "guide" });
    await addField(handler, guide.id, { label: "Title", apiKey: "title", fieldType: "string" });
    await addField(handler, guide.id, {
      label: "Location",
      apiKey: "location",
      fieldType: "link",
      validators: { item_item_type: ["location"] },
    });

    const place = await createModel(handler, { name: "Place", apiKey: "place" });
    await addField(handler, place.id, { label: "Title", apiKey: "title", fieldType: "string" });
    await addField(handler, place.id, {
      label: "Location",
      apiKey: "location",
      fieldType: "link",
      validators: { item_item_type: ["location"] },
    });
    await addField(handler, place.id, {
      label: "Hero Image",
      apiKey: "hero_image",
      fieldType: "media",
    });
    await addField(handler, place.id, {
      label: "Content",
      apiKey: "content",
      fieldType: "structured_text",
      validators: { structured_text_blocks: ["image_block", "quote_block"] },
    });

    const personRecord = await createRecord(handler, "person", { name: "Jane Doe" });
    const locationRecord = await createRecord(handler, "location", { name: "Tokyo" });
    const asset = await createAsset(handler, {
      filename: "place.jpg",
      mimeType: "image/jpeg",
      size: 40000,
      width: 1600,
      height: 900,
      alt: "Place image",
    });

    await createRecord(handler, "guide", { title: "Tokyo Guide", location: locationRecord.id });
    await createRecord(handler, "place", {
      title: "Shibuya Crossing",
      hero_image: asset.id,
      content: {
        value: {
          schema: "dast",
          document: {
            type: "root",
            children: [
              { type: "block", item: "01HCOMPAT_IMG" },
              { type: "block", item: "01HCOMPAT_QUOTE" },
            ],
          },
        },
        blocks: {
          "01HCOMPAT_IMG": { _type: "image_block", image: asset.id },
          "01HCOMPAT_QUOTE": { _type: "quote_block", text: "Worth a visit", author: personRecord.id },
        },
      },
      location: locationRecord.id,
    });

    const result = await gqlQuery(handler, `
      query Place($locationId: ItemId!) {
        allPlaces {
          title
          heroImage {
            responsiveImage(imgixParams: { auto: format, fit: crop, w: 320, h: 320 }) {
              width
              height
            }
          }
          content {
            blocks {
              __typename
              ... on ImageBlockRecord {
                image {
                  responsiveImage(imgixParams: { auto: format, fit: crop, w: 1200, h: 600 }) {
                    width
                    height
                  }
                }
              }
              ... on QuoteBlockRecord {
                text
                author { name }
              }
            }
          }
        }
        location(id: $locationId) {
          _allReferencingGuides { title }
        }
      }
    `, { locationId: locationRecord.id });

    expect(result.errors).toBeUndefined();
    expect(result.data?.allPlaces[0].heroImage.responsiveImage.width).toBe(320);
    expect(result.data?.allPlaces[0].content.blocks).toHaveLength(2);
    expect(result.data?.location._allReferencingGuides[0].title).toBe("Tokyo Guide");
  });

  it("supports _status and _firstPublishedAt meta fields", async () => {
    const article = await createModel(handler, { name: "Article", apiKey: "article" });
    await addField(handler, article.id, { label: "Title", apiKey: "title", fieldType: "string" });

    const record = await createRecord(handler, "article", { title: "Publish me" });
    await publishRecord(handler, "article", record.id);

    const result = await gqlQuery(handler, `{
      allArticles {
        title
        _status
        _firstPublishedAt
      }
    }`, undefined, { includeDrafts: true });

    expect(result.errors).toBeUndefined();
    expect(result.data?.allArticles[0]._status).toBe("published");
    expect(typeof result.data?.allArticles[0]._firstPublishedAt).toBe("string");
  });

  it("supports top-level collection meta count fields", async () => {
    const article = await createModel(handler, { name: "Article", apiKey: "article" });
    await addField(handler, article.id, { label: "Title", apiKey: "title", fieldType: "string" });

    await createRecord(handler, "article", { title: "A" });
    await createRecord(handler, "article", { title: "B" });

    const result = await gqlQuery(handler, `{
      _allArticlesMeta { count }
    }`);

    expect(result.errors).toBeUndefined();
    expect(result.data?._allArticlesMeta.count).toBe(2);
  });

  it("supports field-level locale and fallbackLocales arguments on localized scalars", async () => {
    const tour = await createModel(handler, { name: "Tour", apiKey: "tour" });
    await addField(handler, tour.id, { label: "Title", apiKey: "title", fieldType: "string", localized: true });

    await createRecord(handler, "tour", {
      title: { en: "English title", ja: "日本語タイトル" },
    });

    const result = await gqlQuery(handler, `
      query Tour($locale: SiteLocale!) {
        allTours(locale: $locale) {
          title(fallbackLocales: en)
        }
      }
    `, { locale: "ja" });

    expect(result.errors).toBeUndefined();
    expect(result.data?.allTours[0].title).toBe("日本語タイトル");
  });

  it("supports asset url with imgixParams transform arguments", async () => {
    const post = await createModel(handler, { name: "Post", apiKey: "post" });
    await addField(handler, post.id, { label: "Title", apiKey: "title", fieldType: "string" });
    await addField(handler, post.id, { label: "Cover", apiKey: "cover", fieldType: "media" });

    const asset = await createAsset(handler, {
      filename: "hero.jpg",
      mimeType: "image/jpeg",
      size: 1000,
      width: 1200,
      height: 800,
    });
    await createRecord(handler, "post", { title: "Post", cover: asset.id });

    const result = await gqlQuery(handler, `{
      allPosts {
        cover {
          url(imgixParams: { maxW: 2048, maxH: 1366 })
        }
      }
    }`);

    expect(result.errors).toBeUndefined();
    expect(typeof result.data?.allPosts[0].cover.url).toBe("string");
  });

  it("exposes richer Dato-style asset metadata fields", async () => {
    const post = await createModel(handler, { name: "Post", apiKey: "post" });
    await addField(handler, post.id, { label: "Title", apiKey: "title", fieldType: "string" });
    await addField(handler, post.id, { label: "Cover", apiKey: "cover", fieldType: "media" });

    const asset = await createAsset(handler, {
      filename: "hero.jpg",
      mimeType: "image/jpeg",
      size: 1000,
      width: 1200,
      height: 800,
      blurhash: "LEHV6nWB2yk8pyo0adR*.7kCMdnj",
    });
    await createRecord(handler, "post", { title: "Post", cover: asset.id });

    const result = await gqlQuery(handler, `{
      allPosts {
        cover {
          basename
          format
          smartTags
          tags
        }
      }
    }`);

    expect(result.errors).toBeUndefined();
    expect(result.data?.allPosts[0].cover.basename).toBe("hero");
    expect(result.data?.allPosts[0].cover.format).toBe("jpg");
    expect(result.data?.allPosts[0].cover.smartTags).toEqual([]);
    expect(result.data?.allPosts[0].cover.tags).toEqual([]);
  });

  it("supports upload filtering and ordering by basename and format", async () => {
    await createAsset(handler, {
      filename: "hero.jpg",
      mimeType: "image/jpeg",
      size: 1000,
      width: 1200,
      height: 800,
    });
    await createAsset(handler, {
      filename: "alpha.png",
      mimeType: "image/png",
      size: 500,
      width: 400,
      height: 400,
    });

    const filtered = await gqlQuery(handler, `{
      allUploads(filter: { basename: { eq: "hero" }, format: { eq: "jpg" } }) {
        filename
        basename
        format
      }
    }`);

    expect(filtered.errors).toBeUndefined();
    expect(filtered.data?.allUploads).toEqual([
      { filename: "hero.jpg", basename: "hero", format: "jpg" },
    ]);

    const ordered = await gqlQuery(handler, `{
      allUploads(orderBy: [basename_ASC]) {
        basename
      }
    }`);

    expect(ordered.errors).toBeUndefined();
    expect(ordered.data?.allUploads.map((upload: { basename: string }) => upload.basename)).toEqual(["alpha", "hero"]);
  });

  it("supports hosted video files as regular assets", async () => {
    const page = await createModel(handler, { name: "Page", apiKey: "page" });
    await addField(handler, page.id, { label: "Title", apiKey: "title", fieldType: "string" });
    await addField(handler, page.id, { label: "Featured Video", apiKey: "featured_video", fieldType: "media" });

    const asset = await createAsset(handler, {
      filename: "intro.mp4",
      mimeType: "video/mp4",
      size: 5000000,
    });
    await createRecord(handler, "page", { title: "Home", featured_video: asset.id });

    const result = await gqlQuery(handler, `{
      allPages {
        featuredVideo {
          url
          filename
          format
          mimeType
          size
        }
      }
    }`);

    expect(result.errors).toBeUndefined();
    expect(result.data?.allPages[0].featuredVideo).toEqual({
      url: expect.any(String),
      filename: "intro.mp4",
      format: "mp4",
      mimeType: "video/mp4",
      size: 5000000,
    });
  });

  it("defaults reverse relationship collections to the first 20 records", async () => {
    const location = await createModel(handler, { name: "Location", apiKey: "location" });
    await addField(handler, location.id, { label: "Name", apiKey: "name", fieldType: "string" });

    const guide = await createModel(handler, { name: "Guide", apiKey: "guide" });
    await addField(handler, guide.id, { label: "Title", apiKey: "title", fieldType: "string" });
    await addField(handler, guide.id, {
      label: "Location",
      apiKey: "location",
      fieldType: "link",
      validators: { item_item_type: ["location"] },
    });

    const locationRecord = await createRecord(handler, "location", { name: "Tokyo" });

    for (let index = 1; index <= 25; index += 1) {
      await createRecord(handler, "guide", {
        title: `Guide ${index}`,
        location: locationRecord.id,
      });
    }

    const result = await gqlQuery(handler, `
      query Location($id: ItemId!) {
        location(id: $id) {
          _allReferencingGuides { title }
        }
      }
    `, { id: locationRecord.id });

    expect(result.errors).toBeUndefined();
    expect(result.data?.location._allReferencingGuides).toHaveLength(20);
  });

  it("supports through filtering on reverse relationships", async () => {
    const location = await createModel(handler, { name: "Location", apiKey: "location" });
    await addField(handler, location.id, { label: "Name", apiKey: "name", fieldType: "string" });

    const guide = await createModel(handler, { name: "Guide", apiKey: "guide" });
    await addField(handler, guide.id, { label: "Title", apiKey: "title", fieldType: "string" });
    await addField(handler, guide.id, {
      label: "Primary Location",
      apiKey: "primary_location",
      fieldType: "link",
      validators: { item_item_type: ["location"] },
    });
    await addField(handler, guide.id, {
      label: "Secondary Location",
      apiKey: "secondary_location",
      fieldType: "link",
      validators: { item_item_type: ["location"] },
    });

    const locationRecord = await createRecord(handler, "location", { name: "Tokyo" });
    await createRecord(handler, "guide", { title: "Primary Guide", primary_location: locationRecord.id });
    await createRecord(handler, "guide", { title: "Secondary Guide", secondary_location: locationRecord.id });

    const result = await gqlQuery(handler, `
      query Location($id: ItemId!) {
        location(id: $id) {
          _allReferencingGuides(through: { fields: [primaryLocation] }) {
            title
          }
        }
      }
    `, { id: locationRecord.id });

    expect(result.errors).toBeUndefined();
    expect(result.data?.location._allReferencingGuides).toEqual([{ title: "Primary Guide" }]);
  });

  it("exposes reverse relationship meta count fields", async () => {
    const location = await createModel(handler, { name: "Location", apiKey: "location" });
    await addField(handler, location.id, { label: "Name", apiKey: "name", fieldType: "string" });

    const guide = await createModel(handler, { name: "Guide", apiKey: "guide" });
    await addField(handler, guide.id, { label: "Title", apiKey: "title", fieldType: "string" });
    await addField(handler, guide.id, {
      label: "Location",
      apiKey: "location",
      fieldType: "link",
      validators: { item_item_type: ["location"] },
    });

    const locationRecord = await createRecord(handler, "location", { name: "Tokyo" });
    await createRecord(handler, "guide", { title: "Guide A", location: locationRecord.id });
    await createRecord(handler, "guide", { title: "Guide B", location: locationRecord.id });

    const result = await gqlQuery(handler, `
      query Location($id: ItemId!) {
        location(id: $id) {
          _allReferencingGuidesMeta { count }
        }
      }
    `, { id: locationRecord.id });

    expect(result.errors).toBeUndefined();
    expect(result.data?.location._allReferencingGuidesMeta.count).toBe(2);
  });

  it("exposes editing URLs on records", async () => {
    const article = await createModel(handler, { name: "Article", apiKey: "article" });
    await addField(handler, article.id, { label: "Title", apiKey: "title", fieldType: "string" });
    await createRecord(handler, "article", { title: "Needs editor link" });

    const result = await gqlQuery(handler, `{
      allArticles {
        title
        _editingUrl
      }
    }`);

    expect(result.errors).toBeUndefined();
    expect(typeof result.data?.allArticles[0]._editingUrl).toBe("string");
  });
});
