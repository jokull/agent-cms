import { Effect } from "effect";
import { SqlClient } from "@effect/sql";
import { validateDast, validateBlocksOnly, extractBlockIds } from "../dast/index.js";
import { ValidationError } from "../errors.js";
import type { DastDocument } from "../dast/types.js";

/**
 * Validate and process a StructuredText field value for writing.
 *
 * Input format:
 * {
 *   value: DastDocument,
 *   blocks: { [ulid]: { _type: "hero_section", headline: "...", ... } }
 * }
 *
 * This function:
 * 1. Validates the DAST document structure
 * 2. Validates that all block IDs in the DAST match provided block data
 * 3. Validates block types against the field's whitelist (if any)
 * 4. Writes block rows to their respective block tables
 * 5. Returns the DAST JSON to be stored on the content record
 */
export function writeStructuredText(params: {
  fieldApiKey: string;
  rootRecordId: string;
  value: any;
  blocks?: Record<string, any>;
  allowedBlockTypes?: string[];
  blocksOnly?: boolean;
}) {
  return Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const { fieldApiKey, rootRecordId, value, blocks = {}, allowedBlockTypes, blocksOnly } = params;

    // 1. Validate DAST structure
    const dastErrors = validateDast(value);
    if (dastErrors.length > 0) {
      return yield* new ValidationError({
        message: `Invalid DAST document: ${dastErrors.map((e) => `${e.path}: ${e.message}`).join("; ")}`,
        field: fieldApiKey,
      });
    }

    const dast = value as DastDocument;

    // 1b. Validate blocks-only constraint (modular content / page builder)
    if (blocksOnly) {
      const blocksOnlyErrors = validateBlocksOnly(value);
      if (blocksOnlyErrors.length > 0) {
        return yield* new ValidationError({
          message: `Blocks-only field '${fieldApiKey}': ${blocksOnlyErrors.map((e) => e.message).join("; ")}`,
          field: fieldApiKey,
        });
      }
    }

    // 2. Extract block IDs from DAST and validate they match provided blocks
    const referencedBlockIds = extractBlockIds(dast);
    const providedBlockIds = Object.keys(blocks);

    for (const id of referencedBlockIds) {
      if (!blocks[id]) {
        return yield* new ValidationError({
          message: `DAST references block '${id}' but no block data provided for it`,
          field: fieldApiKey,
        });
      }
    }

    // 3. Validate block types against whitelist
    for (const [blockId, blockData] of Object.entries(blocks)) {
      if (!blockData._type || typeof blockData._type !== "string") {
        return yield* new ValidationError({
          message: `Block '${blockId}' must have a _type property`,
          field: fieldApiKey,
        });
      }

      if (allowedBlockTypes && !allowedBlockTypes.includes(blockData._type)) {
        return yield* new ValidationError({
          message: `Block type '${blockData._type}' is not allowed in field '${fieldApiKey}'. Allowed: ${allowedBlockTypes.join(", ")}`,
          field: fieldApiKey,
        });
      }

      // Verify block type exists in models
      const blockModels = yield* sql.unsafe<{ id: string; api_key: string }>(
        "SELECT id, api_key FROM models WHERE api_key = ? AND is_block = 1",
        [blockData._type]
      );
      if (blockModels.length === 0) {
        return yield* new ValidationError({
          message: `Block type '${blockData._type}' does not exist`,
          field: fieldApiKey,
        });
      }
    }

    // 4. Write block rows
    for (const [blockId, blockData] of Object.entries(blocks)) {
      const blockType = blockData._type;
      const tableName = `block_${blockType}`;

      // Get the fields for this block type
      const blockModel = (yield* sql.unsafe<{ id: string }>(
        "SELECT id FROM models WHERE api_key = ? AND is_block = 1",
        [blockType]
      ))[0];

      const blockFields = yield* sql.unsafe<{ api_key: string; field_type: string }>(
        "SELECT api_key, field_type FROM fields WHERE model_id = ? ORDER BY position",
        [blockModel.id]
      );

      // Build the insert
      const columns = ["id", "_root_record_id", "_root_field_api_key"];
      const placeholders = ["?", "?", "?"];
      const values: any[] = [blockId, rootRecordId, fieldApiKey];

      for (const field of blockFields) {
        const val = blockData[field.api_key];
        if (val !== undefined) {
          columns.push(`"${field.api_key}"`);
          placeholders.push("?");
          values.push(
            typeof val === "object" && val !== null ? JSON.stringify(val) :
            typeof val === "boolean" ? (val ? 1 : 0) :
            val
          );
        }
      }

      yield* sql.unsafe(
        `INSERT INTO "${tableName}" (${columns.join(", ")}) VALUES (${placeholders.join(", ")})`,
        values
      );
    }

    // 5. Return the DAST document to be stored
    return dast;
  });
}

/**
 * Delete all blocks associated with a record's StructuredText field.
 * Used when updating/clearing StructuredText content.
 */
export function deleteBlocksForField(params: {
  rootRecordId: string;
  fieldApiKey: string;
}) {
  return Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const { rootRecordId, fieldApiKey } = params;

    // Find all block type tables
    const blockModels = yield* sql.unsafe<{ api_key: string }>(
      "SELECT api_key FROM models WHERE is_block = 1"
    );

    // Delete from each block table where the root record and field match
    for (const model of blockModels) {
      yield* sql.unsafe(
        `DELETE FROM "block_${model.api_key}" WHERE _root_record_id = ? AND _root_field_api_key = ?`,
        [rootRecordId, fieldApiKey]
      );
    }
  });
}
