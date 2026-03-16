/**
 * Seed script: creates locales, schema, and bilingual content for the i18n example.
 * Run with: npx tsx seed.ts
 */

const BASE = process.env.CMS_URL ?? "http://localhost:8787";

async function api(method: string, path: string, body?: unknown) {
  const res = await fetch(`${BASE}${path}`, {
    method,
    headers: { "Content-Type": "application/json" },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  if (!res.ok && res.status !== 409) {
    const text = await res.text();
    throw new Error(`${method} ${path} → ${res.status}: ${text}`);
  }
  return res.json();
}

async function seed() {
  console.log(`Seeding CMS at ${BASE}...`);

  // --- Locales ---
  const en = await api("POST", "/api/locales", { code: "en" });
  const is_ = await api("POST", "/api/locales", {
    code: "is",
    fallbackLocaleId: en.id,
  });
  console.log("Locales created: en, is");

  // --- Model ---
  const page = await api("POST", "/api/models", {
    name: "Page",
    apiKey: "page",
    singleton: true,
  });

  // --- Fields ---
  await api("POST", `/api/models/${page.id}/fields`, {
    label: "Title",
    apiKey: "title",
    fieldType: "string",
    localized: true,
    validators: { required: true },
  });
  await api("POST", `/api/models/${page.id}/fields`, {
    label: "Body",
    apiKey: "body",
    fieldType: "text",
    localized: true,
  });
  console.log("Model + fields created");

  // --- Content ---
  const record = await api("POST", "/api/records", {
    modelApiKey: "page",
    data: {
      title: { en: "Welcome", is: "Velkomin" },
      body: {
        en: "This page is served in two languages from a single CMS record. Switch locale with the toggle above.",
        is: "Þessi síða er birt á tveimur tungumálum úr einni CMS færslu. Skiptu um tungumál með hnappinum hér að ofan.",
      },
    },
  });
  console.log("Page record created");

  // --- Publish ---
  await api("POST", `/api/records/${record.id}/publish?modelApiKey=page`);
  console.log("Published");

  console.log("\nDone! Visit /en/ and /is/ to see localized content.");
}

seed().catch((e) => {
  console.error(e);
  process.exit(1);
});
