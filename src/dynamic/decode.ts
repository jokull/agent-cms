/**
 * Boundary decode for dynamic rows.
 *
 * Stored content rows carry JSON as TEXT (media references, gallery arrays,
 * localized maps, DAST) and, in the drafts path, a `_published_snapshot`
 * blob. Decoding happens ONCE here, at the extraction edge — downstream code
 * works with plain JS values, never raw stored strings.
 */
import { Exit, Schema } from "effect";
import { decodeJsonIfString, decodeJsonStringOr } from "../json.js";
import { isObjectRecord, type DynamicRow } from "./row-types.js";

/**
 * In the drafts path, overlay the published snapshot of a record when it
 * exists, so draft reads of unchanged fields match their published values.
 */
export function decodeSnapshot(record: DynamicRow, includeDrafts: boolean): DynamicRow {
  if (includeDrafts || !record._published_snapshot) return record;
  const snapshot = decodeJsonIfString(record._published_snapshot);
  if (!isObjectRecord(snapshot)) return record;
  return { ...record, ...snapshot };
}

/** Deserialize JSON string fields in a record. */
export function deserializeRecord(record: DynamicRow): DynamicRow {
  const result: DynamicRow = {};
  for (const [key, value] of Object.entries(record)) {
    if (typeof value === "string" && (value.startsWith("{") || value.startsWith("["))) {
      result[key] = decodeJsonStringOr(value, value);
    } else {
      result[key] = value;
    }
  }
  return result;
}

/**
 * Decode one row with a per-model schema, falling back to the tolerant
 * sniffing decode if the schema rejects it (uncovered legacy shapes must
 * never fail the boundary).
 */
export function decodeRowWithSchema(
  schema: Schema.Schema<Record<string, unknown>>,
  row: DynamicRow,
): DynamicRow {
  // SAFETY: the per-model struct is a ConstraintDecoder over unknown input;
  // the variance cast is the rc.109 form (DecodingServices).
  const exit = Schema.decodeUnknownExit(schema as unknown as Schema.ConstraintDecoder<unknown>)(row);
  if (Exit.isSuccess(exit)) return exit.value as DynamicRow;
  return deserializeRecord(row);
}
