/**
 * Schema lifecycle operations for complex cascading changes.
 * These go beyond simple CRUD and handle content-level cascades.
 */
import { Effect } from "effect";
import { SqlClient } from "@effect/sql";
import { NotFoundError, ValidationError } from "../errors.js";
import type { ModelRow, FieldRow } from "../db/row-types.js";
import { dropTableSql } from "../schema-engine/sql-ddl.js";
import { decodeJsonIfString, decodeJsonRecordStringOr, encodeJson } from "../json.js";

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
      const validators = decodeJsonRecordStringOr(f.validators || "{}", {});
      const allowedBlocks = validators.structured_text_blocks;
      return Array.isArray(allowedBlocks) && allowedBlocks.includes(blockApiKey);
    });

    // For each affected field, clean DAST trees in all records (draft + published snapshot)
    for (const field of affectedFields) {
      const model = yield* sql.unsafe<ModelRow>(
        "SELECT * FROM models WHERE id = ?", [field.model_id]
      );
      if (model.length === 0) continue;

      const tableName = model[0].is_block ? `block_${model[0].api_key}` : `content_${model[0].api_key}`;
      const records = yield* sql.unsafe<Record<string, unknown>>(
        `SELECT id, "${field.api_key}", _published_snapshot FROM "${tableName}" WHERE "${field.api_key}" IS NOT NULL OR _published_snapshot IS NOT NULL`
      );

      for (const record of records) {
        // Remove block nodes referencing this block type
        const blockIds = yield* sql.unsafe<{ id: string }>(
          `SELECT id FROM "block_${blockApiKey}" WHERE _root_record_id = ? AND _root_field_api_key = ?`,
          [record.id, field.api_key]
        );
        const blockIdSet = new Set(blockIds.map((b) => b.id));

        if (blockIdSet.size > 0) {
          // Clean draft DAST
          const dastRaw = decodeJsonIfString(record[field.api_key]);
          const dast = dastRaw as DastLike | null;
          if (dast?.document?.children) {
            const cleaned = removeBlockNodesFromDast(dast, blockIdSet);
            yield* sql.unsafe(
              `UPDATE "${tableName}" SET "${field.api_key}" = ? WHERE id = ?`,
              [encodeJson(cleaned), record.id]
            );
          }

          // Clean published snapshot DAST
          yield* cleanPublishedSnapshot(sql, tableName, String(record.id), field.api_key, blockIdSet);
        }
      }

      // Remove from whitelist
      const validators = decodeJsonRecordStringOr(field.validators || "{}", {});
      const whitelist = Array.isArray(validators.structured_text_blocks)
        ? validators.structured_text_blocks.filter((b): b is string => typeof b === "string")
        : [];
      validators.structured_text_blocks = whitelist.filter((b) => b !== blockApiKey);
      yield* sql.unsafe(
        "UPDATE fields SET validators = ? WHERE id = ?",
        [encodeJson(validators), field.id]
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

    const validators = decodeJsonRecordStringOr(field.validators || "{}", {});
    const whitelist = Array.isArray(validators.structured_text_blocks)
      ? validators.structured_text_blocks.filter((b): b is string => typeof b === "string")
      : [];
    if (!whitelist.includes(blockApiKey))
      return yield* new ValidationError({ message: `Block type '${blockApiKey}' is not in this field's whitelist` });

    // Find the model that owns this field
    const model = yield* sql.unsafe<ModelRow>("SELECT * FROM models WHERE id = ?", [field.model_id]);
    if (model.length === 0) return yield* new NotFoundError({ entity: "Model", id: field.model_id });

    const tableName = model[0].is_block ? `block_${model[0].api_key}` : `content_${model[0].api_key}`;

    // Find block IDs of this type for records of this model/field (scoped to this model's records)
    const blockIds = yield* sql.unsafe<{ id: string }>(
      `SELECT id FROM "block_${blockApiKey}" WHERE _root_field_api_key = ? AND _root_record_id IN (SELECT id FROM "${tableName}")`,
      [field.api_key]
    );
    const blockIdSet = new Set(blockIds.map((b) => b.id));

    // Clean DAST trees (draft + published snapshot) if there are blocks to remove
    let cleanedRecords = 0;
    if (blockIdSet.size > 0) {
      const records = yield* sql.unsafe<Record<string, unknown>>(
        `SELECT id, "${field.api_key}", _published_snapshot FROM "${tableName}" WHERE "${field.api_key}" IS NOT NULL OR _published_snapshot IS NOT NULL`
      );
      for (const record of records) {
        const dastRaw = decodeJsonIfString(record[field.api_key]);
        const dast = dastRaw as DastLike | null;
        if (dast?.document?.children) {
          const cleaned = removeBlockNodesFromDast(dast, blockIdSet);
          yield* sql.unsafe(
            `UPDATE "${tableName}" SET "${field.api_key}" = ? WHERE id = ?`,
            [encodeJson(cleaned), record.id]
          );
          cleanedRecords++;
        }

        // Clean published snapshot
        yield* cleanPublishedSnapshot(sql, tableName, String(record.id), field.api_key, blockIdSet);
      }

      // Delete the block rows (scoped to this model's records)
      yield* sql.unsafe(
        `DELETE FROM "block_${blockApiKey}" WHERE _root_field_api_key = ? AND _root_record_id IN (SELECT id FROM "${tableName}")`,
        [field.api_key]
      );
    }

    // Update whitelist
    validators.structured_text_blocks = whitelist.filter((b: string) => b !== blockApiKey);
    yield* sql.unsafe("UPDATE fields SET validators = ? WHERE id = ?", [encodeJson(validators), fieldId]);

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
      const records = yield* sql.unsafe<Record<string, unknown>>(
        `SELECT id, "${field.api_key}" FROM "${tableName}" WHERE "${field.api_key}" IS NOT NULL`
      );

      for (const record of records) {
        const parsed = decodeJsonIfString(record[field.api_key]);
        if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) continue;

        const localeMap = parsed as Record<string, unknown>;
        if (localeCode in localeMap) {
          delete localeMap[localeCode];
          yield* sql.unsafe(
            `UPDATE "${tableName}" SET "${field.api_key}" = ? WHERE id = ?`,
            [encodeJson(localeMap), record.id]
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

/** Clean DAST inside a record's _published_snapshot for a given field */
function cleanPublishedSnapshot(
  sql: SqlClient.SqlClient,
  tableName: string,
  recordId: string,
  fieldApiKey: string,
  blockIds: Set<string>,
) {
  return Effect.gen(function* () {
    const rows = yield* sql.unsafe<{ _published_snapshot: string | null }>(
      `SELECT _published_snapshot FROM "${tableName}" WHERE id = ?`, [recordId]
    );
    if (!rows[0]?._published_snapshot) return;

    const snapshot = decodeJsonRecordStringOr(rows[0]._published_snapshot, {});
    if (Object.keys(snapshot).length === 0) return;

    const dast = decodeJsonIfString(snapshot[fieldApiKey]);
    snapshot[fieldApiKey] = removeBlockNodesFromStructuredTextValue(dast, blockIds);
    yield* sql.unsafe(
      `UPDATE "${tableName}" SET _published_snapshot = ? WHERE id = ?`,
      [encodeJson(snapshot), recordId]
    );
  });
}

interface DastLike {
  value?: DastLike;
  blocks?: Record<string, unknown>;
  document?: { children?: DastNode[] };
  [key: string]: unknown;
}

interface DastNode {
  type?: string;
  item?: string;
  children?: DastNode[];
  [key: string]: unknown;
}

/** Remove block/inlineBlock nodes whose item IDs are in the given set */
function removeBlockNodesFromDast(dast: DastLike, blockIds: Set<string>): DastLike {
  if (!dast?.document?.children) return dast;

  return {
    ...dast,
    document: {
      ...dast.document,
      children: filterNodes(dast.document.children, blockIds),
    },
  };
}

function removeBlockNodesFromStructuredTextValue(value: unknown, blockIds: Set<string>): unknown {
  if (!value || typeof value !== "object" || Array.isArray(value)) return value;
  const obj = value as DastLike;

  if (obj.value && typeof obj.value === "object" && obj.blocks && typeof obj.blocks === "object") {
    const cleanedBlocks = { ...(obj.blocks as Record<string, unknown>) };
    for (const blockId of blockIds) delete cleanedBlocks[blockId];
    return {
      ...obj,
      value: removeBlockNodesFromDast(obj.value as DastLike, blockIds),
      blocks: cleanedBlocks,
    };
  }

  if (obj.document?.children) {
    return removeBlockNodesFromDast(obj, blockIds);
  }

  return value;
}

function filterNodes(nodes: DastNode[], blockIds: Set<string>): DastNode[] {
  return nodes
    .filter((node) => {
      if ((node.type === "block" || node.type === "inlineBlock") && typeof node.item === "string" && blockIds.has(node.item)) {
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
