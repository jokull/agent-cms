export const MIGRATION_SCHEMA = {
  locales: ["en", "ko", "ja", "zh_CN", "es"],
  models: [
    {
      name: "Site Settings",
      apiKey: "site_settings",
      singleton: true,
      fields: [
        { label: "Site Name", apiKey: "site_name", fieldType: "string", localized: true },
        { label: "Title Suffix", apiKey: "title_suffix", fieldType: "string", localized: true },
        { label: "No Index", apiKey: "no_index", fieldType: "boolean" },
        { label: "Favicon", apiKey: "favicon", fieldType: "media" },
        { label: "Facebook Page URL", apiKey: "facebook_page_url", fieldType: "string", localized: true },
        { label: "Twitter Account", apiKey: "twitter_account", fieldType: "string", localized: true },
        { label: "Fallback SEO", apiKey: "fallback_seo", fieldType: "seo", localized: true },
      ],
    },
    {
      name: "Contributor",
      apiKey: "contributor",
      fields: [
        { label: "Name", apiKey: "name", fieldType: "string", validators: { required: true } },
        { label: "Role", apiKey: "role", fieldType: "string" },
        { label: "Profile Picture", apiKey: "profile_picture", fieldType: "media" },
      ],
    },
    {
      name: "Location",
      apiKey: "location",
      fields: [
        { label: "Name", apiKey: "name", fieldType: "string", localized: true, validators: { required: true } },
        { label: "Slug", apiKey: "slug", fieldType: "slug" },
        { label: "Description", apiKey: "description", fieldType: "text", localized: true },
        { label: "Body", apiKey: "body", fieldType: "structured_text", localized: true },
        { label: "Image", apiKey: "image", fieldType: "media" },
        { label: "Geolocation", apiKey: "geolocation", fieldType: "lat_lon" },
      ],
    },
    {
      name: "Place",
      apiKey: "place",
      fields: [
        { label: "Title", apiKey: "title", fieldType: "string", localized: true, validators: { required: true } },
        { label: "Slug", apiKey: "slug", fieldType: "slug" },
        { label: "Google Places ID", apiKey: "google_places_id", fieldType: "string" },
        { label: "Hero Image", apiKey: "hero_image", fieldType: "media" },
      ],
    },
    {
      name: "Tour",
      apiKey: "tour",
      fields: [
        { label: "Title", apiKey: "title", fieldType: "string", localized: true, validators: { required: true } },
        { label: "Slug", apiKey: "slug", fieldType: "slug" },
        { label: "Summary", apiKey: "summary", fieldType: "text", localized: true },
        { label: "Duration", apiKey: "duration", fieldType: "string" },
        { label: "Tripadvisor Review Count", apiKey: "tripadvisor_review_count", fieldType: "integer" },
        { label: "Tripadvisor Rating", apiKey: "tripadvisor_rating", fieldType: "float" },
        { label: "Hero Image", apiKey: "hero_image", fieldType: "media" },
        { label: "Location", apiKey: "location", fieldType: "link", validators: { item_item_type: ["location"] } },
      ],
    },
    {
      name: "Article",
      apiKey: "article",
      fields: [
        { label: "Title", apiKey: "title", fieldType: "string", localized: true, validators: { required: true } },
        { label: "Slug", apiKey: "slug", fieldType: "slug" },
        { label: "Summary", apiKey: "summary", fieldType: "text", localized: true },
        { label: "Body", apiKey: "body", fieldType: "structured_text", localized: true, validators: { structured_text_blocks: ["tour_card", "image", "video", "table"] } },
        { label: "Date", apiKey: "date", fieldType: "date" },
        { label: "Redirect URL", apiKey: "redirect_url", fieldType: "string" },
        { label: "Hero", apiKey: "hero", fieldType: "media" },
        { label: "Thumbnail", apiKey: "thumbnail", fieldType: "media" },
        { label: "Contributor", apiKey: "contributor", fieldType: "link", validators: { item_item_type: ["contributor"] } },
        { label: "Location", apiKey: "location", fieldType: "link", validators: { item_item_type: ["location"] } },
        { label: "SEO Metadata", apiKey: "seo_metadata", fieldType: "seo", localized: true },
        { label: "TOC Is Visible", apiKey: "toc_is_visible", fieldType: "boolean" },
      ],
    },
    {
      name: "Guide",
      apiKey: "guide",
      fields: [
        { label: "Title", apiKey: "title", fieldType: "string", localized: true, validators: { required: true } },
        { label: "Slug", apiKey: "slug", fieldType: "slug" },
        { label: "Summary", apiKey: "summary", fieldType: "text", localized: true },
        { label: "Body", apiKey: "body", fieldType: "structured_text", localized: true, validators: { structured_text_blocks: ["image", "place_card", "tour_card", "video", "google_place_card"] } },
        { label: "Hero", apiKey: "hero", fieldType: "media" },
        { label: "Thumbnail", apiKey: "thumbnail", fieldType: "media" },
        { label: "Geolocation", apiKey: "geolocation", fieldType: "lat_lon" },
        { label: "Location", apiKey: "location", fieldType: "link", validators: { item_item_type: ["location"] } },
        { label: "SEO Metadata", apiKey: "seo_metadata", fieldType: "seo", localized: true },
      ],
    },
    {
      name: "Image",
      apiKey: "image",
      isBlock: true,
      fields: [
        { label: "Image", apiKey: "image", fieldType: "media" },
      ],
    },
    {
      name: "Video",
      apiKey: "video",
      isBlock: true,
      fields: [
        { label: "Video URL", apiKey: "video_url", fieldType: "video" },
      ],
    },
    {
      name: "Table",
      apiKey: "table",
      isBlock: true,
      fields: [
        { label: "Table Data", apiKey: "table_data", fieldType: "json" },
      ],
    },
    {
      name: "Tour Card",
      apiKey: "tour_card",
      isBlock: true,
      fields: [
        { label: "Description", apiKey: "description", fieldType: "text" },
        { label: "Tour", apiKey: "tour", fieldType: "link", validators: { item_item_type: ["tour"] } },
      ],
    },
    {
      name: "Place Card",
      apiKey: "place_card",
      isBlock: true,
      fields: [
        { label: "Headline", apiKey: "headline", fieldType: "string" },
        { label: "Description", apiKey: "description", fieldType: "structured_text" },
        { label: "Place", apiKey: "place", fieldType: "link", validators: { item_item_type: ["place"] } },
      ],
    },
    {
      name: "Google Place Card",
      apiKey: "google_place_card",
      isBlock: true,
      fields: [
        { label: "Headline", apiKey: "headline", fieldType: "string" },
        { label: "Description", apiKey: "description", fieldType: "structured_text" },
        { label: "Google Place", apiKey: "google_place", fieldType: "json" },
      ],
    },
  ],
};

export function contentModelDependencyOrder() {
  const modelDefs = MIGRATION_SCHEMA.models.filter((model) => !model.isBlock);
  const dependencyMap = new Map(
    modelDefs.map((model) => [model.apiKey, new Set()])
  );

  for (const model of modelDefs) {
    for (const field of model.fields) {
      if (field.fieldType === "link") {
        for (const target of field.validators?.item_item_type ?? []) {
          if (dependencyMap.has(model.apiKey) && dependencyMap.has(target)) {
            dependencyMap.get(model.apiKey).add(target);
          }
        }
      }
    }
  }

  const ordered = [];
  const visited = new Set();
  const visiting = new Set();

  function visit(modelApiKey) {
    if (visited.has(modelApiKey)) return;
    if (visiting.has(modelApiKey)) {
      throw new Error(`Cycle detected in migration model graph at '${modelApiKey}'`);
    }
    visiting.add(modelApiKey);
    for (const dependency of dependencyMap.get(modelApiKey) ?? []) {
      visit(dependency);
    }
    visiting.delete(modelApiKey);
    visited.add(modelApiKey);
    ordered.push(modelApiKey);
  }

  for (const model of modelDefs) {
    visit(model.apiKey);
  }

  return ordered;
}
