import { beforeEach, describe, expect, it } from "vitest";
import { createTestApp, gqlQuery, jsonRequest } from "./app-helpers.js";

describe("Dato query compatibility", () => {
  let handler: (req: Request) => Promise<Response>;

  beforeEach(async () => {
    ({ handler } = createTestApp());

    const enRes = await jsonRequest(handler, "POST", "/api/locales", { code: "en", position: 0 });
    const en = await enRes.json();
    await jsonRequest(handler, "POST", "/api/locales", { code: "ja", position: 1, fallbackLocaleId: en.id });

    const articleRes = await jsonRequest(handler, "POST", "/api/models", { name: "Article", apiKey: "article" });
    const article = await articleRes.json();
    await jsonRequest(handler, "POST", `/api/models/${article.id}/fields`, {
      label: "Title", apiKey: "title", fieldType: "string", localized: true,
    });
    await jsonRequest(handler, "POST", `/api/models/${article.id}/fields`, {
      label: "Slug", apiKey: "slug", fieldType: "slug",
    });

    const guideRes = await jsonRequest(handler, "POST", "/api/models", { name: "Guide", apiKey: "guide" });
    const guide = await guideRes.json();
    await jsonRequest(handler, "POST", `/api/models/${guide.id}/fields`, {
      label: "Title", apiKey: "title", fieldType: "string", localized: true,
    });
    await jsonRequest(handler, "POST", `/api/models/${guide.id}/fields`, {
      label: "Slug", apiKey: "slug", fieldType: "slug",
    });
    await jsonRequest(handler, "POST", `/api/models/${guide.id}/fields`, {
      label: "Location", apiKey: "location", fieldType: "link", validators: { item_item_type: ["location"] },
    });

    const locationRes = await jsonRequest(handler, "POST", "/api/models", { name: "Location", apiKey: "location" });
    const location = await locationRes.json();
    await jsonRequest(handler, "POST", `/api/models/${location.id}/fields`, {
      label: "Name", apiKey: "name", fieldType: "string", localized: true,
    });
    await jsonRequest(handler, "POST", `/api/models/${location.id}/fields`, {
      label: "Slug", apiKey: "slug", fieldType: "slug",
    });

    const locationRecordRes = await jsonRequest(handler, "POST", "/api/records", {
      modelApiKey: "location",
      data: { name: { en: "Tokyo", ja: "東京" }, slug: "tokyo" },
    });
    const locationRecord = await locationRecordRes.json();

    await jsonRequest(handler, "POST", "/api/records", {
      modelApiKey: "article",
      data: {
        title: { en: "English Title", ja: "日本語タイトル" },
        slug: "english-title",
      },
    });

    await jsonRequest(handler, "POST", "/api/records", {
      modelApiKey: "guide",
      data: {
        title: { en: "Tokyo Guide", ja: "東京ガイド" },
        slug: "tokyo-guide",
        location: locationRecord.id,
      },
    });
  });

  it("supports Dato-style Record type names and SiteLocale fallback arguments", async () => {
    const result = await gqlQuery(handler, `
      query Article($slug: String!, $locale: SiteLocale!) {
        article(locale: $locale, fallbackLocales: en, filter: { slug: { eq: $slug } }) {
          __typename
          ... on ArticleRecord {
            id
            title
            slug
          }
        }
      }
    `, { slug: "english-title", locale: "ja" });

    expect(result.errors).toBeUndefined();
    expect(result.data?.article.__typename).toBe("ArticleRecord");
    expect(result.data?.article.title).toBe("日本語タイトル");
  });

  it("supports ItemId and returns reverse refs with Record typenames", async () => {
    const ids = await gqlQuery(handler, `{ allLocations { id } allGuides { id } }`);
    const locationId = ids.data?.allLocations[0]?.id;
    const guideId = ids.data?.allGuides[0]?.id;

    const guideResult = await gqlQuery(handler, `
      query Guide($id: ItemId!, $locale: SiteLocale!) {
        guide(locale: $locale, fallbackLocales: en, filter: { id: { eq: $id } }) {
          __typename
          id
          title
        }
      }
    `, { id: guideId, locale: "ja" });

    expect(guideResult.errors).toBeUndefined();
    expect(guideResult.data?.guide.__typename).toBe("GuideRecord");
    expect(guideResult.data?.guide.title).toBe("東京ガイド");

    const result = await gqlQuery(handler, `
      query Location($id: ItemId!, $locale: SiteLocale!) {
        location(id: $id) {
          __typename
          ... on LocationRecord {
            id
            _allReferencingGuides(locale: $locale, fallbackLocales: en) {
              __typename
              id
              title
            }
          }
        }
      }
    `, { id: locationId, locale: "ja" });

    expect(result.errors).toBeUndefined();
    expect(result.data?.location.__typename).toBe("LocationRecord");
    expect(result.data?.location._allReferencingGuides[0].__typename).toBe("GuideRecord");
    expect(result.data?.location._allReferencingGuides[0].title).toBe("東京ガイド");
    expect(guideId).toBeTruthy();
  });
});
