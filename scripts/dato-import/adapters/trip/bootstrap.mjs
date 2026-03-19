import { pathToFileURL } from "node:url";
import { Effect } from "effect";

import { ACTIVE_LOCALES, configureTripRuntime, ensureField, ensureLocale, ensureModel } from "./common.mjs";
import { MIGRATION_SCHEMA } from "./schema.mjs";

export async function runBootstrap(options = {}) {
  return Effect.runPromise(createBootstrapProgram(options));
}

export function createBootstrapProgram(options = {}) {
  configureTripRuntime(options);

  return Effect.gen(function* () {
    const localeByCode = new Map();
    yield* Effect.forEach(ACTIVE_LOCALES, (code, index) =>
      Effect.tryPromise(async () => {
        const fallbackLocaleId = code === "en" ? null : localeByCode.get("en")?.id ?? null;
        const locale = await ensureLocale(code, fallbackLocaleId, index);
        localeByCode.set(code, locale);
      }), { concurrency: 1 });

    yield* Effect.forEach(
      MIGRATION_SCHEMA.models,
      (modelDef) =>
        Effect.tryPromise(async () => {
          const model = await ensureModel({
            name: modelDef.name,
            apiKey: modelDef.apiKey,
            isBlock: Boolean(modelDef.isBlock),
            singleton: Boolean(modelDef.singleton),
          });
          for (const fieldDef of modelDef.fields) {
            await ensureField(model.id, fieldDef);
          }
        }),
      { concurrency: 1 },
    );

    yield* Effect.logInfo(`Bootstrapped locales: ${ACTIVE_LOCALES.join(", ")}`);
    yield* Effect.logInfo(`Bootstrapped models: ${MIGRATION_SCHEMA.models.map((model) => model.apiKey).join(", ")}`);
  });
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await runBootstrap();
}
