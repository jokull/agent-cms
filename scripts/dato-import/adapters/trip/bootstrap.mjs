import { ACTIVE_LOCALES, ensureField, ensureLocale, ensureModel } from "./common.mjs";
import { MIGRATION_SCHEMA } from "./schema.mjs";

const localeByCode = new Map();
for (let index = 0; index < ACTIVE_LOCALES.length; index++) {
  const code = ACTIVE_LOCALES[index];
  const fallbackLocaleId = code === "en" ? null : localeByCode.get("en")?.id ?? null;
  const locale = await ensureLocale(code, fallbackLocaleId, index);
  localeByCode.set(code, locale);
}

for (const modelDef of MIGRATION_SCHEMA.models) {
  const model = await ensureModel({
    name: modelDef.name,
    apiKey: modelDef.apiKey,
    isBlock: Boolean(modelDef.isBlock),
    singleton: Boolean(modelDef.singleton),
  });
  for (const fieldDef of modelDef.fields) {
    await ensureField(model.id, fieldDef);
  }
}

console.log(`Bootstrapped locales: ${ACTIVE_LOCALES.join(", ")}`);
console.log(`Bootstrapped models: ${MIGRATION_SCHEMA.models.map((model) => model.apiKey).join(", ")}`);
