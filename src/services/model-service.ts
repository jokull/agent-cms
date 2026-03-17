import { Effect, Schema } from "effect";
import { SqlClient } from "@effect/sql";
import { ulid } from "ulidx";
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
import { CreateModelInput } from "./input-schemas.js";

export function listModels() {
  return Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    return yield* sql.unsafe<ModelRow>("SELECT * FROM models ORDER BY created_at");
  });
}

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
      ...models[0],
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

export function createModel(rawBody: unknown) {
  return Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;

    const body = yield* Schema.decodeUnknown(CreateModelInput)(rawBody).pipe(
      Effect.mapError((e) => new ValidationError({ message: `Invalid input: ${e.message}` }))
    );

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

    const now = new Date().toISOString();
    const id = ulid();

    yield* sql.unsafe(
      `INSERT INTO models (id, name, api_key, is_block, singleton, sortable, tree, has_draft, all_locales_required, ordering, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        id, body.name, body.apiKey,
        body.isBlock ? 1 : 0,
        body.singleton ? 1 : 0,
        body.sortable ? 1 : 0,
        body.tree ? 1 : 0,
        body.hasDraft ? 1 : 0,
        body.allLocalesRequired ? 1 : 0,
        body.ordering ?? null,
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

    return {
      id, name: body.name, apiKey: body.apiKey,
      isBlock: body.isBlock, singleton: body.singleton,
      sortable: body.sortable, tree: body.tree,
      hasDraft: body.hasDraft,
      allLocalesRequired: body.allLocalesRequired,
      ordering: body.ordering ?? null,
      createdAt: now, updatedAt: now,
    };
  });
}

export function updateModel(id: string, body: Record<string, unknown>) {
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

    // Handle api_key rename → rename the dynamic table
    if (typeof body.apiKey === "string" && body.apiKey !== model.api_key) {
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
        const validators = JSON.parse(f.validators || "{}");
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
          yield* sql.unsafe("UPDATE fields SET validators = ? WHERE id = ?", [JSON.stringify(validators), f.id]);
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

    const updated = yield* sql.unsafe<ModelRow>("SELECT * FROM models WHERE id = ?", [id]);
    return updated[0];
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
        const validators = JSON.parse(f.validators || "{}");
        const allowedTypes = validators?.items_item_type ?? validators?.item_item_type;
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
        const validators = JSON.parse(f.validators || "{}");
        const whitelist = validators?.block_whitelist;
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
          message: `Cannot delete block type '${model.api_key}': referenced by structured_text fields: ${refs.join(", ")}. Use remove_block_type to clean up DAST references first.`,
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

    return { deleted: true, recordsDestroyed };
  });
}
