/**
 * Seed script for the visual-edit example.
 * Creates locales, a singleton page model with fields, and sample content.
 *
 * Usage: npx tsx seed.ts [CMS_URL]
 * Default CMS_URL: http://localhost:8787
 */

const CMS_URL = process.argv[2] ?? "http://localhost:8787";
const WRITE_KEY = "dev";

const headers = {
  "Content-Type": "application/json",
  Authorization: `Bearer ${WRITE_KEY}`,
};

async function api(method: string, path: string, body?: unknown) {
  const res = await fetch(`${CMS_URL}${path}`, {
    method,
    headers,
    body: body ? JSON.stringify(body) : undefined,
  });
  const json = await res.json();
  if (!res.ok) {
    console.error(`${method} ${path} → ${res.status}`, json);
    throw new Error(`API error: ${res.status}`);
  }
  console.log(`${method} ${path} → ${res.status}`);
  return json;
}

async function main() {
  // Setup database
  await api("POST", "/api/setup");

  // Create locales
  const enLocale = await api("POST", "/api/locales", { code: "en", position: 0 }) as { id: string };
  await api("POST", "/api/locales", { code: "is", position: 1, fallbackLocaleId: enLocale.id });

  // --- Block model: image_block ---
  const imageBlock = await api("POST", "/api/models", {
    name: "Image Block",
    apiKey: "image_block",
    isBlock: true,
  }) as { id: string };

  await api("POST", `/api/models/${imageBlock.id}/fields`, {
    label: "Image",
    apiKey: "image",
    fieldType: "media",
    validators: { required: {} },
  });

  await api("POST", `/api/models/${imageBlock.id}/fields`, {
    label: "Caption",
    apiKey: "caption",
    fieldType: "string",
  });

  // --- Page model (singleton) ---
  const model = await api("POST", "/api/models", {
    name: "Page",
    apiKey: "page",
    singleton: true,
    hasDraft: true,
  }) as { id: string };

  await api("POST", `/api/models/${model.id}/fields`, {
    label: "Title",
    apiKey: "title",
    fieldType: "string",
    localized: true,
    validators: { required: {} },
  });

  await api("POST", `/api/models/${model.id}/fields`, {
    label: "Hero Image",
    apiKey: "hero_image",
    fieldType: "media",
  });

  await api("POST", `/api/models/${model.id}/fields`, {
    label: "Body",
    apiKey: "body",
    fieldType: "structured_text",
    localized: true,
    validators: {
      structured_text_blocks: ["image_block"],
    },
  });

  // --- Assets ---
  const heroAsset = await api("POST", "/api/assets", {
    id: "hero-placeholder",
    filename: "hero.jpg",
    mimeType: "image/jpeg",
    size: 0,
    width: 1200,
    height: 800,
    alt: "Hero placeholder",
  }) as { id: string };

  const blockImageAsset = await api("POST", "/api/assets", {
    id: "block-image-1",
    filename: "feature-screenshot.jpg",
    mimeType: "image/jpeg",
    size: 0,
    width: 800,
    height: 600,
    alt: "Visual editing in action",
  }) as { id: string };

  // --- Page record with bilingual content ---
  const blockId = "img-block-1";

  const record = await api("POST", "/api/records", {
    modelApiKey: "page",
    data: {
      title: {
        en: "Welcome to Agent CMS",
        is: "Velkomin í Agent CMS",
      },
      hero_image: heroAsset.id,
      body: {
        en: {
          value: {
            schema: "dast",
            document: {
              type: "root",
              children: [
                {
                  type: "paragraph",
                  children: [
                    {
                      type: "span",
                      value: "This is a visual editing demo. Hover over any content to see edit controls.",
                    },
                  ],
                },
                {
                  type: "heading",
                  level: 2,
                  children: [
                    { type: "span", value: "Features" },
                  ],
                },
                {
                  type: "list",
                  style: "bulleted",
                  children: [
                    {
                      type: "listItem",
                      children: [
                        {
                          type: "paragraph",
                          children: [
                            { type: "span", value: "Inline text editing", marks: ["strong"] },
                            { type: "span", value: " — click any title to edit it" },
                          ],
                        },
                      ],
                    },
                    {
                      type: "listItem",
                      children: [
                        {
                          type: "paragraph",
                          children: [
                            { type: "span", value: "Structured text editing", marks: ["strong"] },
                            { type: "span", value: " — click body text to open a markdown editor" },
                          ],
                        },
                      ],
                    },
                    {
                      type: "listItem",
                      children: [
                        {
                          type: "paragraph",
                          children: [
                            { type: "span", value: "Image replacement", marks: ["strong"] },
                            { type: "span", value: " — click any image to replace it" },
                          ],
                        },
                      ],
                    },
                  ],
                },
                // Image block embedded in the structured text
                { type: "block", item: blockId },
                {
                  type: "paragraph",
                  children: [
                    { type: "span", value: "The image above is an " },
                    { type: "span", value: "image block", marks: ["strong"] },
                    { type: "span", value: " inside structured text — hover it to swap the image." },
                  ],
                },
                {
                  type: "paragraph",
                  children: [
                    { type: "span", value: "Add " },
                    { type: "span", value: "?edit=true", marks: ["code"] },
                    { type: "span", value: " to the URL to enable edit mode." },
                  ],
                },
              ],
            },
          },
          blocks: {
            [blockId]: {
              _type: "image_block",
              image: blockImageAsset.id,
              caption: "Visual editing in action",
            },
          },
        },
        is: {
          value: {
            schema: "dast",
            document: {
              type: "root",
              children: [
                {
                  type: "paragraph",
                  children: [
                    {
                      type: "span",
                      value: "Þetta er sýnishorn af sjónrænum breytingum. Sveiflaðu yfir efni til að sjá breytingaviðmót.",
                    },
                  ],
                },
                {
                  type: "heading",
                  level: 2,
                  children: [
                    { type: "span", value: "Eiginleikar" },
                  ],
                },
                {
                  type: "list",
                  style: "bulleted",
                  children: [
                    {
                      type: "listItem",
                      children: [
                        {
                          type: "paragraph",
                          children: [
                            { type: "span", value: "Beinn texta breytingar", marks: ["strong"] },
                          ],
                        },
                      ],
                    },
                    {
                      type: "listItem",
                      children: [
                        {
                          type: "paragraph",
                          children: [
                            { type: "span", value: "Skipulögð texta breyting", marks: ["strong"] },
                          ],
                        },
                      ],
                    },
                    {
                      type: "listItem",
                      children: [
                        {
                          type: "paragraph",
                          children: [
                            { type: "span", value: "Mynda skipti", marks: ["strong"] },
                          ],
                        },
                      ],
                    },
                  ],
                },
              ],
            },
          },
          blocks: {},
        },
      },
    },
  }) as { id: string };

  // Publish the record
  await api("POST", `/api/records/${record.id}/publish?modelApiKey=page`);

  console.log("\nSeed complete! Run the CMS and site to test visual editing.");
  console.log(`  CMS: cd cms && npx wrangler dev`);
  console.log(`  Site: cd site && npx astro dev`);
  console.log(`  Open: http://localhost:4321/en/?edit=true`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
