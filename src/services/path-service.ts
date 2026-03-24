/**
 * Canonical path resolver — batch-resolves canonical_path_template for all
 * published records of a model, traversing link fields via dot notation.
 *
 * Template examples:
 *   /blog/{slug}                         — flat field
 *   /blog/{category.slug}/{slug}         — one-hop link traversal
 *   /{category.parent.slug}/{category.slug}/{slug} — multi-hop
 *
 * Unresolvable tokens (null link, missing field) are left as-is: {token}.
 */
import { Effect } from "effect";
import { SqlClient } from "@effect/sql";
import { NotFoundError, ValidationError } from "../errors.js";
import type { ModelRow, FieldRow } from "../db/row-types.js";
import { getLinkTargets } from "../db/validators.js";
import { decodeJsonRecordStringOr } from "../json.js";

const MAX_DEPTH = 10;

/** A parsed token from the template, e.g. {category.parent.slug} → ["category", "parent", "slug"] */
interface TemplateToken {
  raw: string; // "category.parent.slug"
  segments: string[]; // ["category", "parent", "slug"]
}

function parseTemplateTokens(template: string): TemplateToken[] {
  const tokens: TemplateToken[] = [];
  const re = /\{([^}]+)\}/g;
  let match: RegExpExecArray | null;
  while ((match = re.exec(template)) !== null) {
    tokens.push({ raw: match[1], segments: match[1].split(".") });
  }
  return tokens;
}

function parseValidators(raw: string | null | undefined): Record<string, unknown> {
  if (!raw || raw === "") return {};
  return decodeJsonRecordStringOr(raw, {});
}

/**
 * Resolve canonical paths for all published records of a model.
 * Returns array of { id, path, lastmod }.
 */
export function resolveCanonicalPaths(modelApiKey: string) {
  return Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;

    // 1. Load model
    const models = yield* sql.unsafe<ModelRow>(
      "SELECT * FROM models WHERE api_key = ?",
      [modelApiKey],
    );
    if (models.length === 0) {
      return yield* new NotFoundError({ entity: "Model", id: modelApiKey });
    }
    const model = models[0];
    const template = model.canonical_path_template;
    if (!template) {
      return yield* new ValidationError({
        message: `Model "${modelApiKey}" has no canonical_path_template. Set one via update_model before resolving paths.`,
      });
    }

    // 2. Parse template tokens
    const tokens = parseTemplateTokens(template);
    if (tokens.length === 0) {
      return yield* new ValidationError({
        message: `Template "${template}" contains no {field} tokens.`,
      });
    }

    // 3. Load fields for this model (needed to identify link fields)
    const fields = yield* sql.unsafe<FieldRow>(
      "SELECT * FROM fields WHERE model_id = ? ORDER BY position",
      [model.id],
    );
    const fieldsByApiKey = new Map(fields.map((f) => [f.api_key, f]));

    // 4. Fetch all published records (only columns we need)
    const neededColumns = new Set<string>(["id", "_published_at", "_updated_at"]);
    for (const token of tokens) {
      neededColumns.add(token.segments[0]); // first segment is always a field on this model
    }
    const columnList = [...neededColumns].map((c) => `"${c}"`).join(", ");
    const records = yield* sql.unsafe<Record<string, unknown>>(
      `SELECT ${columnList} FROM "content_${modelApiKey}" WHERE "_status" IN ('published', 'updated')`,
    );

    if (records.length === 0) return [];

    // 5. Identify which tokens need link traversal (multi-segment)
    const linkTokens = tokens.filter((t) => t.segments.length > 1);

    // 6. Breadth-first link resolution
    // resolvedValues: Map<recordId, Map<tokenRaw, resolvedValue>>
    const resolvedValues = new Map<string, Map<string, string>>();
    for (const rec of records) {
      resolvedValues.set(rec.id as string, new Map());
    }

    // For single-segment tokens, resolve immediately from the record
    for (const token of tokens) {
      if (token.segments.length === 1) {
        const fieldName = token.segments[0];
        for (const rec of records) {
          const value = rec[fieldName];
          if (value !== null && value !== undefined) {
            resolvedValues.get(rec.id as string)!.set(token.raw, String(value));
          }
        }
      }
    }

    // For multi-segment tokens, resolve hop by hop
    if (linkTokens.length > 0) {
      yield* resolveLinkedTokens(sql, linkTokens, records, fieldsByApiKey, resolvedValues);
    }

    // 7. Substitute tokens into template
    const results: Array<{ id: string; path: string; lastmod: string }> = [];
    for (const rec of records) {
      const recId = rec.id as string;
      const values = resolvedValues.get(recId)!;
      const path = template.replace(/\{([^}]+)\}/g, (_match, tokenRaw: string) => {
        const resolved = values.get(tokenRaw);
        if (resolved !== undefined) return encodeURIComponent(resolved);
        return `{${tokenRaw}}`; // leave unreplaced
      });
      const publishedAt = rec._published_at as string | null;
      const updatedAt = rec._updated_at as string | null;
      const lastmod = laterTimestamp(publishedAt, updatedAt) ?? new Date().toISOString();
      results.push({ id: recId, path, lastmod });
    }

    return results;
  });
}

function laterTimestamp(a: string | null, b: string | null): string | null {
  if (!a && !b) return null;
  if (!a) return b;
  if (!b) return a;
  return a > b ? a : b;
}

/**
 * Resolve multi-segment tokens by traversing link fields breadth-first.
 *
 * For each hop level, we:
 * 1. Collect all link IDs we need to fetch
 * 2. Look up the target model from field validators
 * 3. Batch-fetch all linked records
 * 4. Continue to next hop with the linked records
 */
function resolveLinkedTokens(
  sql: SqlClient.SqlClient,
  tokens: TemplateToken[],
  records: readonly Record<string, unknown>[],
  fieldsByApiKey: Map<string, FieldRow>,
  resolvedValues: Map<string, Map<string, string>>,
) {
  return Effect.gen(function* () {
    // Group tokens by their traversal path prefix
    // For each token, we need to resolve hop by hop
    // e.g., {category.parent.slug} needs: record.category → cat.parent → parent.slug

    // Track the "frontier" of records at each hop level
    // frontier: Map<tokenRaw, Map<originalRecordId, currentLinkedRecord>>
    type Frontier = Map<string, Record<string, unknown>>;

    // Initialize frontier with the source records
    // tokenFrontier: Map<tokenRaw, Map<originalRecordId, frontier>>
    const tokenFrontiers = new Map<string, Map<string, Frontier>>();

    for (const token of tokens) {
      const frontierMap = new Map<string, Frontier>();
      for (const rec of records) {
        const recId = rec.id as string;
        const frontier = new Map<string, Record<string, unknown>>();
        frontier.set(recId, rec);
        frontierMap.set(recId, frontier);
      }
      tokenFrontiers.set(token.raw, frontierMap);
    }

    // Process tokens grouped by first segment to batch efficiently
    // Group tokens by their prefix path to share batched fetches
    for (const token of tokens) {
      const segments = token.segments;
      // Walk each hop
      let currentRecords = new Map<string, Record<string, unknown>>();
      // Map original record ID → current linked record
      for (const rec of records) {
        currentRecords.set(rec.id as string, rec);
      }

      // Current model's fields (start with the source model)
      let currentFieldsByApiKey = fieldsByApiKey;
      let hopsCompleted = 0;
      const hopsNeeded = segments.length - 1;

      for (let hop = 0; hop < hopsNeeded; hop++) {
        if (hop >= MAX_DEPTH) break;

        const fieldName = segments[hop];
        const field = currentFieldsByApiKey.get(fieldName);
        if (!field || field.field_type !== "link") break;

        const validators = parseValidators(field.validators);
        const targetApiKeys = getLinkTargets(validators);
        if (!targetApiKeys || targetApiKeys.length === 0) break;

        // Collect all link IDs to fetch
        const linkIdToOriginalRecords = new Map<string, string[]>();
        for (const [origId, rec] of currentRecords) {
          const linkId = rec[fieldName];
          if (typeof linkId === "string" && linkId) {
            const list = linkIdToOriginalRecords.get(linkId) ?? [];
            list.push(origId);
            linkIdToOriginalRecords.set(linkId, list);
          }
        }

        // Records with null links simply drop out of currentRecords
        // (they won't appear in nextRecords, so the leaf won't resolve for them)

        // Batch-fetch linked records from all target models
        const linkedRecords = new Map<string, Record<string, unknown>>();
        if (linkIdToOriginalRecords.size > 0) {
          const idsToFetch = [...linkIdToOriginalRecords.keys()];
          for (const targetApiKey of targetApiKeys) {
            if (idsToFetch.length === 0) break;
            const placeholders = idsToFetch.map(() => "?").join(", ");
            const rows = yield* sql.unsafe<Record<string, unknown>>(
              `SELECT * FROM "content_${targetApiKey}" WHERE "id" IN (${placeholders})`,
              idsToFetch,
            );
            for (const row of rows) {
              linkedRecords.set(row.id as string, row);
            }
          }
        }

        // Update currentRecords: map original IDs to their linked records
        const nextRecords = new Map<string, Record<string, unknown>>();
        for (const [origId, rec] of currentRecords) {
          const linkId = rec[fieldName];
          if (typeof linkId === "string" && linkId) {
            const linked = linkedRecords.get(linkId);
            if (linked) {
              nextRecords.set(origId, linked);
            }
          }
          // Records with null/missing link are intentionally dropped —
          // the token stays unreplaced for them.
        }
        currentRecords = nextRecords;

        // Load fields for the target model (for next hop)
        const targetModel = yield* sql.unsafe<ModelRow>(
          `SELECT * FROM "models" WHERE "api_key" = ?`,
          [targetApiKeys[0]],
        );
        if (targetModel.length === 0) break;
        const targetFields = yield* sql.unsafe<FieldRow>(
          `SELECT * FROM "fields" WHERE "model_id" = ? ORDER BY position`,
          [targetModel[0].id],
        );
        currentFieldsByApiKey = new Map(targetFields.map((f) => [f.api_key, f]));
        hopsCompleted++;
      }

      // Only resolve leaf if all hops completed (the chain wasn't broken by
      // a missing field definition or model). Records that had null links at
      // any hop simply dropped out of currentRecords and won't be resolved.
      if (hopsCompleted === hopsNeeded) {
        const leafField = segments[segments.length - 1];
        for (const [origId, linkedRec] of currentRecords) {
          const value = linkedRec[leafField];
          if (value !== null && value !== undefined) {
            resolvedValues.get(origId)!.set(token.raw, String(value));
          }
        }
      }
    }
  });
}
