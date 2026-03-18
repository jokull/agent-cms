/**
 * Schema import/export — portable JSON format for CMS schemas.
 *
 * Export produces a self-contained JSON with no IDs (references by api_key).
 * Import creates all locales, models, and fields in dependency order.
 */
import { Effect } from "effect";
import { SqlClient } from "@effect/sql";
import { ValidationError } from "../errors.js";
import type { ModelRow, FieldRow, LocaleRow } from "../db/row-types.js";
import * as ModelService from "./model-service.js";
import * as FieldService from "./field-service.js";
import * as LocaleService from "./locale-service.js";
import type { ImportSchemaInput } from "./input-schemas.js";

// ---------------------------------------------------------------------------
// Export format (portable, no IDs)
// ---------------------------------------------------------------------------

export interface SchemaExportField {
  label: string;
  apiKey: string;
  fieldType: string;
  position: number;
  localized: boolean;
  validators: Record<string, unknown>;
  hint: string | null;
}

export interface SchemaExportModel {
  name: string;
  apiKey: string;
  isBlock: boolean;
  singleton: boolean;
  sortable: boolean;
  tree: boolean;
  hasDraft: boolean;
  fields: SchemaExportField[];
}

export interface SchemaExportLocale {
  code: string;
  position: number;
  fallbackLocale: string | null; // locale code, not ID
}

export interface SchemaExport {
  version: 1;
  locales: SchemaExportLocale[];
  models: SchemaExportModel[];
}

// ---------------------------------------------------------------------------
// Export
// ---------------------------------------------------------------------------

export function exportSchema() {
  return Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;

    const localeRows = yield* sql.unsafe<LocaleRow>(
      "SELECT * FROM locales ORDER BY position"
    );
    const modelRows = yield* sql.unsafe<ModelRow>(
      "SELECT * FROM models ORDER BY is_block, created_at"
    );
    const fieldRows = yield* sql.unsafe<FieldRow>(
      "SELECT * FROM fields ORDER BY model_id, position"
    );

    // Build locale code lookup for fallback resolution
    const localeIdToCode = new Map<string, string>();
    for (const l of localeRows) localeIdToCode.set(l.id, l.code);

    const locales: SchemaExportLocale[] = localeRows.map((l) => ({
      code: l.code,
      position: l.position,
      fallbackLocale: l.fallback_locale_id
        ? (localeIdToCode.get(l.fallback_locale_id) ?? null)
        : null,
    }));

    // Group fields by model
    const fieldsByModelId = new Map<string, FieldRow[]>();
    for (const f of fieldRows) {
      const list = fieldsByModelId.get(f.model_id) ?? [];
      list.push(f);
      fieldsByModelId.set(f.model_id, list);
    }

    const models: SchemaExportModel[] = modelRows.map((m) => ({
      name: m.name,
      apiKey: m.api_key,
      isBlock: !!m.is_block,
      singleton: !!m.singleton,
      sortable: !!m.sortable,
      tree: !!m.tree,
      hasDraft: !!m.has_draft,
      fields: (fieldsByModelId.get(m.id) ?? []).map((f) => ({
        label: f.label,
        apiKey: f.api_key,
        fieldType: f.field_type,
        position: f.position,
        localized: !!f.localized,
        validators: JSON.parse(f.validators || "{}"),
        hint: f.hint,
      })),
    }));

    return { version: 1, locales, models } satisfies SchemaExport;
  });
}

// ---------------------------------------------------------------------------
// Import
// ---------------------------------------------------------------------------

export function importSchema(s: ImportSchemaInput) {
  return Effect.gen(function* () {
    const stats = { locales: 0, models: 0, fields: 0 };

    // --- 1. Create locales (in position order, resolve fallbacks) ---
    const localeCodeToId = new Map<string, string>();

    if (s.locales.length > 0) {
      // First pass: create locales without fallbacks
      const sortedLocales = [...s.locales].sort((a, b) => a.position - b.position);
      for (const locale of sortedLocales) {
        const result = yield* LocaleService.createLocale({
          code: locale.code,
          position: locale.position,
        });
        localeCodeToId.set(locale.code, result.id);
        stats.locales++;
      }

      // Second pass: set fallback locale IDs
      const sql = yield* SqlClient.SqlClient;
      for (const locale of sortedLocales) {
        if (locale.fallbackLocale) {
          const fallbackId = localeCodeToId.get(locale.fallbackLocale);
          if (fallbackId) {
            const localeId = localeCodeToId.get(locale.code);
            yield* sql.unsafe(
              "UPDATE locales SET fallback_locale_id = ? WHERE id = ?",
              [fallbackId, localeId]
            );
          }
        }
      }
    }

    // --- 2. Create all models (without fields, so tables exist for link references) ---
    const modelApiKeyToId = new Map<string, string>();

    for (const model of s.models) {
      const result = yield* ModelService.createModel({
        name: model.name,
        apiKey: model.apiKey,
        isBlock: model.isBlock,
        singleton: model.singleton,
        sortable: model.sortable,
        tree: model.tree,
        hasDraft: model.hasDraft,
        allLocalesRequired: false,
      });
      modelApiKeyToId.set(model.apiKey, result.id);
      stats.models++;
    }

    // --- 3. Create all fields (models exist, so link/links validators resolve) ---
    for (const model of s.models) {
      const modelId = modelApiKeyToId.get(model.apiKey);
      if (modelId === undefined) {
        return yield* Effect.fail(new ValidationError({ message: `Model "${model.apiKey}" was not created — cannot attach fields` }));
        continue;
      }
      for (const field of model.fields) {
        yield* FieldService.createField(modelId, {
          label: field.label,
          apiKey: field.apiKey,
          fieldType: field.fieldType,
          position: field.position,
          localized: field.localized,
          validators: field.validators,
          hint: field.hint ?? undefined,
        });
        stats.fields++;
      }
    }

    return stats;
  });
}
