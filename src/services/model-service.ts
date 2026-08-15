import { Effect } from "effect";
import { SqlClient } from "effect/unstable/sql";
import { generateId } from "../id.js";
import {
  NotFoundError,
  ValidationError,
  DuplicateError,
  ReferenceConflictError,
} from "../errors.js";
import { migrateContentTable, dropTableSql } from "../schema-engine/sql-ddl.js";
import * as SearchService from "../search/search-service.js";
import type { ModelRow, FieldRow } from "../db/row-types.js";
import { parseFieldValidators } from "../db/row-types.js";
import type { CreateModelInput, UpdateModelInput } from "./input-schemas.js";
import { decodeJsonRecordStringOr, encodeJson } from "../json.js";
import { bumpSchemaVersion } from "./schema-version.js";

/**
 * Canonical wire shape for a content model returned by the REST API and MCP
 * tools: camelCase keys, real booleans (not SQLite 0/1). Every model-returning
 * handler serializes through `serializeModel` so `list`/`get`/`create`/`update`
 * all agree on one shape.
 */
export interface ModelApiResponse {
  readonly id: string;
  readonly name: string;
  readonly apiKey: string;
  readonly isBlock: boolean;
  readonly singleton: boolean;
  readonly sortable: boolean;
  readonly tree: boolean;
  readonly hasDraft: boolean;
  readonly allLocalesRequired: boolean;
  readonly ordering: string | null;
  readonly canonicalPathTemplate: string | null;
  readonly titleField: string | null;
  readonly imagePreviewField: string | null;
  readonly createdAt: string;
  readonly updatedAt: string;
}

/** Convert a raw `models` row (snake_case, SQLite integer booleans) to the canonical API shape. */
export function serializeModel(row: ModelRow): ModelApiResponse {
  return {
    id: row.id,
    name: row.name,
    apiKey: row.api_key,
    isBlock: row.is_block === 1,
    singleton: row.singleton === 1,
    sortable: row.sortable === 1,
    tree: row.tree === 1,
    hasDraft: row.has_draft === 1,
    allLocalesRequired: row.all_locales_required === 1,
    ordering: row.ordering,
    canonicalPathTemplate: row.canonical_path_template,
    titleField: row.title_field,
    imagePreviewField: row.image_preview_field,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

/**
 * Validate a presentation-hint value (title_field / image_preview_field) against
 * the model's current fields. `null` always passes (clearing is always allowed).
 * A non-null value must reference an existing field api_key on the model;
 * `requireMediaType` additionally requires that field's type to be `media`
 * (DatoCMS requires the image-preview hint to point at an asset field).
 */
function validateHintField(
  sql: SqlClient.SqlClient,
  modelId: string,
  hintName: "title_field" | "image_preview_field",
  value: string | null,
  requireMediaType: boolean
) {
  return Effect.gen(function* () {
    if (value === null) return;
    const matches = yield* sql.unsafe<FieldRow>(
      "SELECT * FROM fields WHERE model_id = ? AND api_key = ?",
      [modelId, value]
    );
    if (matches.length === 0) {
      return yield* new ValidationError({
        message: `${hintName} '${value}' does not match any field api_key on this model`,
      });
    }
    if (requireMediaType && matches[0].field_type !== "media") {
      return yield* new ValidationError({
        message: `image_preview_field '${value}' must reference a field of type 'media', got '${matches[0].field_type}'`,
      });
    }
  });
}

/** List all models in the canonical API shape (used by the REST `GET /models` handler). */
export function listModels() {
  return Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const rows = yield* sql.unsafe<ModelRow>("SELECT * FROM models ORDER BY created_at");
    return rows.map(serializeModel);
  });
}

/**
 * Get a single model by id, in the canonical API shape, with its fields attached
 * (used by the REST `GET /models/:id` handler). `fields` stays raw `FieldRow[]`
 * (validators parsed) — tightening that shape too is a separate concern.
 */
export function getModel(id: string) {
  return Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const models = yield* sql.unsafe<ModelRow>("SELECT * FROM models WHERE id = ?", [id]);
    if (models.length === 0) return yield* new NotFoundError({ entity: "Model", id });

    const fields = yield* sql.unsafe<FieldRow>(
      "SELECT * FROM fields WHERE model_id = ? ORDER BY position",
      [id]
    );

    return {
      ...serializeModel(models[0]),
      fields: fields.map(parseFieldValidators),
    };
  });
}

export function getModelByApiKey(apiKey: string) {
  return Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const models = yield* sql.unsafe<ModelRow>("SELECT * FROM models WHERE api_key = ?", [apiKey]);
    if (models.length === 0) return yield* new NotFoundError({ entity: "Model", id: apiKey });

    const fields = yield* sql.unsafe<FieldRow>(
      "SELECT * FROM fields WHERE model_id = ? ORDER BY position",
      [models[0].id]
    );

    return {
      ...models[0],
      fields: fields.map(parseFieldValidators),
    };
  });
}

export function createModel(body: CreateModelInput) {
  return Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;

    if (!/^[a-z][a-z0-9_]*$/.test(body.apiKey))
      return yield* new ValidationError({
        message: "apiKey must start with a lowercase letter and contain only lowercase letters, numbers, and underscores",
      });

    const existing = yield* sql.unsafe<{ id: string }>(
      "SELECT id FROM models WHERE api_key = ?",
      [body.apiKey]
    );
    if (existing.length > 0)
      return yield* new DuplicateError({ message: `Model with apiKey '${body.apiKey}' already exists` });

    // Presentation hints reference fields, which don't exist yet at creation
    // time — only null is accepted here. Set them via PATCH once fields exist.
    if (body.titleField != null)
      return yield* new ValidationError({
        message: "titleField cannot be set at model creation — fields don't exist yet; set it via PATCH after adding fields",
      });
    if (body.imagePreviewField != null)
      return yield* new ValidationError({
        message: "imagePreviewField cannot be set at model creation — fields don't exist yet; set it via PATCH after adding fields",
      });

    const now = new Date().toISOString();
    const id = generateId();

    yield* sql.unsafe(
      `INSERT INTO models (id, name, api_key, is_block, singleton, sortable, tree, has_draft, all_locales_required, ordering, canonical_path_template, title_field, image_preview_field, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        id, body.name, body.apiKey,
        body.isBlock ? 1 : 0,
        body.singleton ? 1 : 0,
        body.sortable ? 1 : 0,
        body.tree ? 1 : 0,
        body.hasDraft ? 1 : 0,
        body.allLocalesRequired ? 1 : 0,
        body.ordering ?? null,
        body.canonicalPathTemplate ?? null,
        null,
        null,
        now, now,
      ]
    );

    yield* migrateContentTable(body.apiKey, body.isBlock, [], {
      sortable: body.sortable,
      tree: body.tree,
    });

    // Create FTS5 table for content models (not block types)
    if (!body.isBlock) {
      yield* SearchService.createFtsTable(body.apiKey).pipe(Effect.ignore);
    }

    yield* bumpSchemaVersion();

    return serializeModel({
      id, name: body.name, api_key: body.apiKey,
      is_block: body.isBlock ? 1 : 0,
      singleton: body.singleton ? 1 : 0,
      sortable: body.sortable ? 1 : 0,
      tree: body.tree ? 1 : 0,
      has_draft: body.hasDraft ? 1 : 0,
      all_locales_required: body.allLocalesRequired ? 1 : 0,
      ordering: body.ordering ?? null,
      canonical_path_template: body.canonicalPathTemplate ?? null,
      title_field: null,
      image_preview_field: null,
      created_at: now, updated_at: now,
    });
  });
}

export function updateModel(id: string, body: UpdateModelInput) {
  return Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const existing = yield* sql.unsafe<ModelRow>("SELECT * FROM models WHERE id = ?", [id]);
    if (existing.length === 0) return yield* new NotFoundError({ entity: "Model", id });

    const model = existing[0];
    const now = new Date().toISOString();
    const sets: string[] = ["updated_at = ?"];
    const values: unknown[] = [now];

    if (body.name !== undefined) { sets.push("name = ?"); values.push(body.name); }
    if (body.singleton !== undefined) { sets.push("singleton = ?"); values.push(body.singleton ? 1 : 0); }
    if (body.sortable !== undefined) { sets.push("sortable = ?"); values.push(body.sortable ? 1 : 0); }
    if (body.hasDraft !== undefined) { sets.push("has_draft = ?"); values.push(body.hasDraft ? 1 : 0); }
    if (body.allLocalesRequired !== undefined) { sets.push("all_locales_required = ?"); values.push(body.allLocalesRequired ? 1 : 0); }
    if (body.ordering !== undefined) { sets.push("ordering = ?"); values.push(body.ordering); }
    if (body.canonicalPathTemplate !== undefined) { sets.push("canonical_path_template = ?"); values.push(body.canonicalPathTemplate); }

    if (body.titleField !== undefined) {
      yield* validateHintField(sql, id, "title_field", body.titleField, false);
      sets.push("title_field = ?");
      values.push(body.titleField);
    }
    if (body.imagePreviewField !== undefined) {
      yield* validateHintField(sql, id, "image_preview_field", body.imagePreviewField, true);
      sets.push("image_preview_field = ?");
      values.push(body.imagePreviewField);
    }

    // Handle api_key rename → rename the dynamic table
    if (body.apiKey !== undefined && body.apiKey !== model.api_key) {
      const newApiKey = body.apiKey;
      if (!/^[a-z][a-z0-9_]*$/.test(newApiKey))
        return yield* new ValidationError({ message: "apiKey must start with a lowercase letter and contain only lowercase letters, numbers, and underscores" });

      // Check for conflicts
      const conflict = yield* sql.unsafe<{ id: string }>("SELECT id FROM models WHERE api_key = ? AND id != ?", [newApiKey, id]);
      if (conflict.length > 0)
        return yield* new DuplicateError({ message: `Model with apiKey '${newApiKey}' already exists` });

      const oldPrefix = model.is_block ? "block_" : "content_";
      const oldTableName = `${oldPrefix}${model.api_key}`;
      const newTableName = `${oldPrefix}${newApiKey}`;

      // Rename the table
      yield* sql.unsafe(`ALTER TABLE "${oldTableName}" RENAME TO "${newTableName}"`);

      // Rename FTS table if it exists (content models only)
      if (!model.is_block) {
        yield* SearchService.dropIndex(model.api_key).pipe(Effect.ignore);
        yield* SearchService.createFtsTable(newApiKey).pipe(Effect.ignore);
      }

      // Update _root_field_api_key won't change since that tracks the field, not the model
      // But we need to update validators in other models that reference this model by api_key
      const allFields = yield* sql.unsafe<FieldRow>("SELECT * FROM fields WHERE field_type IN ('link', 'links', 'structured_text')");
      for (const f of allFields) {
        const validators = decodeJsonRecordStringOr(f.validators || "{}", {});
        let changed = false;
        // Update link/links validators
        for (const key of ["item_item_type", "items_item_type"]) {
          if (Array.isArray(validators[key])) {
            const idx = validators[key].indexOf(model.api_key);
            if (idx !== -1) {
              validators[key][idx] = newApiKey;
              changed = true;
            }
          }
        }
        // Update structured_text block whitelists
        if (Array.isArray(validators.structured_text_blocks)) {
          const idx = validators.structured_text_blocks.indexOf(model.api_key);
          if (idx !== -1) {
            validators.structured_text_blocks[idx] = newApiKey;
            changed = true;
          }
        }
        if (changed) {
          yield* sql.unsafe("UPDATE fields SET validators = ? WHERE id = ?", [encodeJson(validators), f.id]);
        }
      }

      sets.push("api_key = ?");
      values.push(newApiKey);
    }

    yield* sql.unsafe(`UPDATE models SET ${sets.join(", ")} WHERE id = ?`, [...values, id]);

    // Rebuild FTS index if apiKey was renamed (model row now has the new apiKey)
    if (typeof body.apiKey === "string" && body.apiKey !== model.api_key && !model.is_block) {
      yield* SearchService.rebuildIndex(body.apiKey).pipe(Effect.ignore);
    }

    yield* bumpSchemaVersion();

    const updated = yield* sql.unsafe<ModelRow>("SELECT * FROM models WHERE id = ?", [id]);
    return serializeModel(updated[0]);
  });
}

export function deleteModel(id: string) {
  return Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const models = yield* sql.unsafe<ModelRow>("SELECT * FROM models WHERE id = ?", [id]);
    if (models.length === 0) return yield* new NotFoundError({ entity: "Model", id });

    const model = models[0];

    // Check for references before deletion
    const allFields = yield* sql.unsafe<FieldRow>("SELECT * FROM fields");

    if (!model.is_block) {
      // Content models: check link/links references
      const referencingFields = allFields.filter((f) => {
        if (f.field_type !== "link" && f.field_type !== "links") return false;
        if (f.model_id === id) return false;
        const validators = decodeJsonRecordStringOr(f.validators || "{}", {});
        const allowedTypes = validators.items_item_type ?? validators.item_item_type;
        return Array.isArray(allowedTypes) && allowedTypes.includes(model.api_key);
      });

      if (referencingFields.length > 0) {
        const refs: string[] = [];
        for (const f of referencingFields) {
          const refModels = yield* sql.unsafe<{ api_key: string }>(
            "SELECT api_key FROM models WHERE id = ?",
            [f.model_id]
          );
          refs.push(`${refModels[0]?.api_key ?? "unknown"}.${f.api_key}`);
        }
        return yield* new ReferenceConflictError({
          message: `Cannot delete model '${model.api_key}': referenced by fields: ${refs.join(", ")}`,
          references: refs,
        });
      }
    } else {
      // Block models: check structured_text field whitelists
      const referencingFields = allFields.filter((f) => {
        if (f.field_type !== "structured_text") return false;
        const validators = decodeJsonRecordStringOr(f.validators || "{}", {});
        const whitelist = validators.block_whitelist;
        return Array.isArray(whitelist) && whitelist.includes(model.api_key);
      });

      if (referencingFields.length > 0) {
        const refs: string[] = [];
        for (const f of referencingFields) {
          const refModels = yield* sql.unsafe<{ api_key: string }>(
            "SELECT api_key FROM models WHERE id = ?",
            [f.model_id]
          );
          refs.push(`${refModels[0]?.api_key ?? "unknown"}.${f.api_key}`);
        }
        return yield* new ReferenceConflictError({
          message: `Cannot delete block type '${model.api_key}': referenced by structured_text fields: ${refs.join(", ")}. Use remove_block to clean up DAST references first.`,
          references: refs,
        });
      }
    }

    const tableName = model.is_block ? `block_${model.api_key}` : `content_${model.api_key}`;

    // Count records before dropping
    const countResult = yield* sql.unsafe<{ c: number }>(
      `SELECT COUNT(*) as c FROM "${tableName}"`
    );
    const recordsDestroyed = countResult[0]?.c ?? 0;

    // Delete associated fields first
    yield* sql.unsafe("DELETE FROM fields WHERE model_id = ?", [id]);

    yield* dropTableSql(tableName);
    yield* SearchService.dropIndex(model.api_key).pipe(Effect.ignore);
    yield* sql.unsafe("DELETE FROM models WHERE id = ?", [id]);

    yield* bumpSchemaVersion();

    return { deleted: true, recordsDestroyed };
  });
}
