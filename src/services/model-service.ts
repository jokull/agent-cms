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
      `INSERT INTO models (id, name, api_key, is_block, singleton, sortable, tree, has_draft, ordering, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        id, body.name, body.apiKey,
        body.isBlock ? 1 : 0,
        body.singleton ? 1 : 0,
        body.sortable ? 1 : 0,
        body.tree ? 1 : 0,
        body.hasDraft ? 1 : 0,
        body.ordering ?? null,
        now, now,
      ]
    );

    yield* migrateContentTable(body.apiKey, body.isBlock, []);

    return {
      id, name: body.name, apiKey: body.apiKey,
      isBlock: body.isBlock, singleton: body.singleton,
      sortable: body.sortable, tree: body.tree,
      hasDraft: body.hasDraft,
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

    const now = new Date().toISOString();
    const sets: string[] = ["updated_at = ?"];
    const values: unknown[] = [now];

    if (body.name !== undefined) { sets.push("name = ?"); values.push(body.name); }
    if (body.singleton !== undefined) { sets.push("singleton = ?"); values.push(body.singleton ? 1 : 0); }
    if (body.sortable !== undefined) { sets.push("sortable = ?"); values.push(body.sortable ? 1 : 0); }
    if (body.hasDraft !== undefined) { sets.push("has_draft = ?"); values.push(body.hasDraft ? 1 : 0); }

    yield* sql.unsafe(`UPDATE models SET ${sets.join(", ")} WHERE id = ?`, [...values, id]);

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

    if (!model.is_block) {
      const allFields = yield* sql.unsafe<FieldRow>("SELECT * FROM fields");
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
    }

    const tableName = model.is_block ? `block_${model.api_key}` : `content_${model.api_key}`;
    yield* dropTableSql(tableName);
    yield* sql.unsafe("DELETE FROM models WHERE id = ?", [id]);

    return { deleted: true };
  });
}
