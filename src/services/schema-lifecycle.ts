/**
 * Schema lifecycle operations for complex cascading changes.
 * These go beyond simple CRUD and handle content-level cascades.
 */
import { Effect } from "effect";
import { SqlClient } from "@effect/sql";
import { NotFoundError, ValidationError, ReferenceConflictError } from "../errors.js";
import type { ModelRow, FieldRow } from "../db/row-types.js";
import { dropTableSql } from "../schema-engine/sql-ddl.js";

/**
 * P4.4: Remove a block type — scans all StructuredText fields,
 * cleans DAST trees, deletes block rows, drops the block table.
 */
export function removeBlockType(blockApiKey: string) {
  return Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;

    // Find the block model
    const blockModels = yield* sql.unsafe<ModelRow>(
      "SELECT * FROM models WHERE api_key = ? AND is_block = 1", [blockApiKey]
    );
    if (blockModels.length === 0) return yield* new NotFoundError({ entity: "Block type", id: blockApiKey });

    const blockModel = blockModels[0];

    // Find all StructuredText fields that reference this block type in their whitelist
    const stFields = yield* sql.unsafe<FieldRow>(
      "SELECT * FROM fields WHERE field_type = 'structured_text'"
    );

    const affectedFields = stFields.filter((f) => {
      const validators = JSON.parse(f.validators || "{}");
      const allowedBlocks = validators.structured_text_blocks;
      return Array.isArray(allowedBlocks) && allowedBlocks.includes(blockApiKey);
    });

    // For each affected field, clean DAST trees in all records
    for (const field of affectedFields) {
      const model = yield* sql.unsafe<ModelRow>(
        "SELECT * FROM models WHERE id = ?", [field.model_id]
      );
      if (model.length === 0) continue;

      const tableName = model[0].is_block ? `block_${model[0].api_key}` : `content_${model[0].api_key}`;
      const records = yield* sql.unsafe<{ id: string; [key: string]: any }>(
        `SELECT id, "${field.api_key}" FROM "${tableName}" WHERE "${field.api_key}" IS NOT NULL`
      );

      for (const record of records) {
        let dast = record[field.api_key];
        if (typeof dast === "string") {
          try { dast = JSON.parse(dast); } catch { continue; }
        }
        if (!dast?.document?.children) continue;

        // Remove block nodes referencing this block type
        const blockIds = yield* sql.unsafe<{ id: string }>(
          `SELECT id FROM "block_${blockApiKey}" WHERE _root_record_id = ? AND _root_field_api_key = ?`,
          [record.id, field.api_key]
        );
        const blockIdSet = new Set(blockIds.map((b) => b.id));

        if (blockIdSet.size > 0) {
          const cleaned = removeBlockNodesFromDast(dast, blockIdSet);
          yield* sql.unsafe(
            `UPDATE "${tableName}" SET "${field.api_key}" = ? WHERE id = ?`,
            [JSON.stringify(cleaned), record.id]
          );
        }
      }

      // Remove from whitelist
      const validators = JSON.parse(field.validators || "{}");
      validators.structured_text_blocks = (validators.structured_text_blocks ?? [])
        .filter((b: string) => b !== blockApiKey);
      yield* sql.unsafe(
        "UPDATE fields SET validators = ? WHERE id = ?",
        [JSON.stringify(validators), field.id]
      );
    }

    // Delete all block rows
    yield* sql.unsafe(`DELETE FROM "block_${blockApiKey}"`);

    // Drop the block table
    yield* dropTableSql(`block_${blockApiKey}`);

    // Delete associated fields
    yield* sql.unsafe("DELETE FROM fields WHERE model_id = ?", [blockModel.id]);

    // Delete the model
    yield* sql.unsafe("DELETE FROM models WHERE id = ?", [blockModel.id]);

    return { deleted: true, affectedFields: affectedFields.length };
  });
}

/**
 * P4.5: Remove a block type from a field's whitelist (without deleting the type).
 * Cleans affected DAST trees by removing block nodes of that type.
 */
export function removeBlockFromWhitelist(params: {
  fieldId: string;
  blockApiKey: string;
}) {
  return Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const { fieldId, blockApiKey } = params;

    const fields = yield* sql.unsafe<FieldRow>("SELECT * FROM fields WHERE id = ?", [fieldId]);
    if (fields.length === 0) return yield* new NotFoundError({ entity: "Field", id: fieldId });

    const field = fields[0];
    if (field.field_type !== "structured_text")
      return yield* new ValidationError({ message: "Field is not a structured_text field" });

    const validators = JSON.parse(field.validators || "{}");
    const whitelist: string[] = validators.structured_text_blocks ?? [];
    if (!whitelist.includes(blockApiKey))
      return yield* new ValidationError({ message: `Block type '${blockApiKey}' is not in this field's whitelist` });

    // Find the model that owns this field
    const model = yield* sql.unsafe<ModelRow>("SELECT * FROM models WHERE id = ?", [field.model_id]);
    if (model.length === 0) return yield* new NotFoundError({ entity: "Model", id: field.model_id });

    const tableName = model[0].is_block ? `block_${model[0].api_key}` : `content_${model[0].api_key}`;

    // Find block IDs of this type for records of this model/field
    const blockIds = yield* sql.unsafe<{ id: string }>(
      `SELECT id FROM "block_${blockApiKey}" WHERE _root_field_api_key = ?`,
      [field.api_key]
    );
    const blockIdSet = new Set(blockIds.map((b) => b.id));

    // Clean DAST trees if there are blocks to remove
    let cleanedRecords = 0;
    if (blockIdSet.size > 0) {
      const records = yield* sql.unsafe<{ id: string; [key: string]: any }>(
        `SELECT id, "${field.api_key}" FROM "${tableName}" WHERE "${field.api_key}" IS NOT NULL`
      );
      for (const record of records) {
        let dast = record[field.api_key];
        if (typeof dast === "string") { try { dast = JSON.parse(dast); } catch { continue; } }
        if (!dast?.document?.children) continue;

        const cleaned = removeBlockNodesFromDast(dast, blockIdSet);
        yield* sql.unsafe(
          `UPDATE "${tableName}" SET "${field.api_key}" = ? WHERE id = ?`,
          [JSON.stringify(cleaned), record.id]
        );
        cleanedRecords++;
      }

      // Delete the block rows
      yield* sql.unsafe(
        `DELETE FROM "block_${blockApiKey}" WHERE _root_field_api_key = ?`,
        [field.api_key]
      );
    }

    // Update whitelist
    validators.structured_text_blocks = whitelist.filter((b: string) => b !== blockApiKey);
    yield* sql.unsafe("UPDATE fields SET validators = ? WHERE id = ?", [JSON.stringify(validators), fieldId]);

    return { removed: blockApiKey, cleanedRecords, blocksDeleted: blockIdSet.size };
  });
}

/**
 * P4.6: Remove a locale — strips the locale key from all localized field
 * values across all models.
 */
export function removeLocale(localeId: string) {
  return Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;

    // Find the locale
    const locales = yield* sql.unsafe<{ id: string; code: string }>(
      "SELECT id, code FROM locales WHERE id = ?", [localeId]
    );
    if (locales.length === 0) return yield* new NotFoundError({ entity: "Locale", id: localeId });

    const localeCode = locales[0].code;

    // Find all localized fields
    const localizedFields = yield* sql.unsafe<FieldRow>(
      "SELECT * FROM fields WHERE localized = 1"
    );

    let updatedRecords = 0;

    for (const field of localizedFields) {
      const model = yield* sql.unsafe<ModelRow>(
        "SELECT * FROM models WHERE id = ?", [field.model_id]
      );
      if (model.length === 0) continue;

      const tableName = model[0].is_block ? `block_${model[0].api_key}` : `content_${model[0].api_key}`;
      const records = yield* sql.unsafe<{ id: string; [key: string]: any }>(
        `SELECT id, "${field.api_key}" FROM "${tableName}" WHERE "${field.api_key}" IS NOT NULL`
      );

      for (const record of records) {
        let value = record[field.api_key];
        if (typeof value === "string") { try { value = JSON.parse(value); } catch { continue; } }
        if (typeof value !== "object" || value === null || Array.isArray(value)) continue;

        if (localeCode in value) {
          delete value[localeCode];
          yield* sql.unsafe(
            `UPDATE "${tableName}" SET "${field.api_key}" = ? WHERE id = ?`,
            [JSON.stringify(value), record.id]
          );
          updatedRecords++;
        }
      }
    }

    // Delete the locale
    yield* sql.unsafe("DELETE FROM locales WHERE id = ?", [localeId]);

    return { deleted: localeCode, updatedRecords, fieldsScanned: localizedFields.length };
  });
}

/** Remove block/inlineBlock nodes whose item IDs are in the given set */
function removeBlockNodesFromDast(dast: any, blockIds: Set<string>): any {
  if (!dast?.document?.children) return dast;

  return {
    ...dast,
    document: {
      ...dast.document,
      children: filterNodes(dast.document.children, blockIds),
    },
  };
}

function filterNodes(nodes: any[], blockIds: Set<string>): any[] {
  return nodes
    .filter((node) => {
      if ((node.type === "block" || node.type === "inlineBlock") && blockIds.has(node.item)) {
        return false;
      }
      return true;
    })
    .map((node) => {
      if (Array.isArray(node.children)) {
        return { ...node, children: filterNodes(node.children, blockIds) };
      }
      return node;
    });
}
