/**
 * Build GraphQL types and resolvers for block models.
 * Also computes per-field StructuredText union types.
 */
import { Effect } from "effect";
import { SqlClient } from "@effect/sql";
import type { AssetRow } from "../db/row-types.js";
import { getLinkTargets, getLinksTargets, getBlockWhitelist } from "../db/validators.js";
import { extractBlockIds, extractInlineBlockIds, extractLinkIds } from "../dast/index.js";
import type { SchemaBuilderContext, DynamicRow, DastDocInput } from "./gql-types.js";
import { toTypeName, toCamelCase, fieldToSDL, getRegistryDef, deserializeRecord } from "./gql-utils.js";

/**
 * Build block model resolvers, compute structured text union types,
 * and emit deferred block SDL. Returns the structuredTextFieldTypes map.
 */
export function buildBlockModelResolvers(ctx: SchemaBuilderContext): Map<string, string> {
  const {
    blockModels, models, fieldsByModelId, typeNames, blockTypeNames,
    resolvers, typeDefs, runSql, assetUrl,
  } = ctx;

  // Deferred SDL: we need to compute structured text unions first
  const deferredBlockModelSDL: Array<{
    bmApiKey: string;
    bmTypeName: string;
    bmFields: typeof fieldsByModelId extends Map<string, infer V> ? V : never;
  }> = [];

  for (const bm of blockModels) {
    const bmTypeName = blockTypeNames.get(bm.api_key)!;
    const bmFields = fieldsByModelId.get(bm.id) ?? [];
    deferredBlockModelSDL.push({ bmApiKey: bm.api_key, bmTypeName, bmFields });

    // Resolvers for block model types
    const bmResolvers: Record<string, unknown> = {};
    bmResolvers._modelApiKey = () => bm.api_key;

    // camelCase -> snake_case field resolvers + media/link resolvers
    for (const f of bmFields) {
      const gqlName = toCamelCase(f.api_key);

      if (f.field_type === "media") {
        bmResolvers[gqlName] = async (parent: DynamicRow) => {
          const assetId = parent[f.api_key];
          if (!assetId) return null;
          const rows = await runSql(
            Effect.gen(function* () {
              const s = yield* SqlClient.SqlClient;
              return yield* s.unsafe<AssetRow>("SELECT * FROM assets WHERE id = ?", [assetId]);
            })
          );
          if (rows.length === 0) return null;
          const a = rows[0];
          return {
            id: a.id, filename: a.filename, mimeType: a.mime_type,
            size: a.size, width: a.width, height: a.height,
            alt: a.alt, title: a.title, blurhash: a.blurhash ?? null,
            url: assetUrl(a.id, a.filename),
          };
        };
      } else if (f.field_type === "link") {
        const targets = getLinkTargets(f.validators);
        if (targets && targets.length > 0) {
          bmResolvers[gqlName] = async (parent: DynamicRow) => {
            const linkedId = parent[f.api_key];
            if (!linkedId) return null;
            // Search across target content tables
            for (const apiKey of targets) {
              const tName = typeNames.get(apiKey);
              const rows = await runSql(
                Effect.gen(function* () {
                  const s = yield* SqlClient.SqlClient;
                  return yield* s.unsafe<DynamicRow>(
                    `SELECT * FROM "content_${apiKey}" WHERE id = ?`, [linkedId]
                  );
                })
              );
              if (rows.length > 0) {
                return { ...deserializeRecord(rows[0]), __typename: tName ? `${tName}Record` : undefined };
              }
            }
            return null;
          };
        }
      } else if (f.field_type === "structured_text") {
        bmResolvers[gqlName] = async (parent: DynamicRow) => {
          let raw = parent[f.api_key];
          if (!raw) return null;
          if (typeof raw === "string") {
            try { raw = JSON.parse(raw); } catch { return null; }
          }

          const rawObj = raw as DynamicRow;
          // Block ST fields store the full envelope {value: {schema,document}, blocks: {...}}
          // Unwrap to get the DAST document and any embedded block data
          const dast = rawObj.document ? rawObj : (rawObj.value ?? rawObj);
          const embeddedBlocks: DynamicRow = (rawObj.blocks ?? {}) as DynamicRow;

          // Extract block IDs from the DAST
          const blockLevelIds = new Set(extractBlockIds(dast as DastDocInput));
          const inlineBlockIdSet = new Set(extractInlineBlockIds(dast as DastDocInput));

          const blocks: DynamicRow[] = [];
          const inlineBlocks: DynamicRow[] = [];

          if (blockLevelIds.size > 0 || inlineBlockIdSet.size > 0) {
            const allIds = [...blockLevelIds, ...inlineBlockIdSet];

            // First: resolve from embedded block data (nested blocks stored as JSON inside parent)
            for (const id of allIds) {
              const embedded = embeddedBlocks[id];
              if (embedded && typeof embedded === "object") {
                const embObj = embedded as DynamicRow;
                const blockType = embObj._type as string | undefined;
                const bmtn = blockType ? `${toTypeName(blockType)}Record` : undefined;
                const resolved = { id, ...embObj, __typename: bmtn };
                if (blockLevelIds.has(id)) blocks.push(resolved);
                else inlineBlocks.push(resolved);
              }
            }

            // Fallback: try block tables for any IDs not found in embedded data
            const resolvedIds = new Set([
              ...blocks.map((b) => b.id as string),
              ...inlineBlocks.map((b) => b.id as string),
            ]);
            const unresolvedIds = allIds.filter((id) => !resolvedIds.has(id));

            if (unresolvedIds.length > 0) {
              for (const innerBm of blockModels) {
                const placeholders = unresolvedIds.map(() => "?").join(", ");
                const fetched = await runSql(
                  Effect.gen(function* () {
                    const s = yield* SqlClient.SqlClient;
                    const rows = yield* s.unsafe<DynamicRow>(
                      `SELECT * FROM "block_${innerBm.api_key}" WHERE id IN (${placeholders})`,
                      unresolvedIds
                    );
                    return rows.map((r: DynamicRow) => {
                      const deserialized = deserializeRecord(r);
                      return { id: String(deserialized.id ?? ""), ...deserialized, __typename: `${toTypeName(innerBm.api_key)}Record` };
                    });
                  })
                );
                for (const record of fetched) {
                  if (blockLevelIds.has(record.id as string)) blocks.push(record);
                  else if (inlineBlockIdSet.has(record.id as string)) inlineBlocks.push(record);
                  else blocks.push(record);
                }
              }
            }
          }

          // Resolve link references
          const linkRecordIds = extractLinkIds(dast as DastDocInput);
          const allModelApiKeys = models.map((m) => m.api_key);
          const links: DynamicRow[] = [];
          for (const linkId of linkRecordIds) {
            for (const apiKey of allModelApiKeys) {
              const tName = typeNames.get(apiKey);
              const rows = await runSql(
                Effect.gen(function* () {
                  const s = yield* SqlClient.SqlClient;
                  return yield* s.unsafe<DynamicRow>(
                    `SELECT * FROM "content_${apiKey}" WHERE id = ?`, [linkId]
                  );
                })
              );
              if (rows.length > 0) {
                links.push({ ...deserializeRecord(rows[0]), __typename: tName ? `${tName}Record` : undefined });
                break;
              }
            }
          }

          return { value: dast, blocks, inlineBlocks, links };
        };
      } else if (f.field_type === "links") {
        const targets = getLinksTargets(f.validators);
        if (targets && targets.length > 0) {
          bmResolvers[gqlName] = async (parent: DynamicRow) => {
            let linkedIds = parent[f.api_key];
            if (typeof linkedIds === "string") {
              try { linkedIds = JSON.parse(linkedIds); } catch { return []; }
            }
            if (!Array.isArray(linkedIds)) return [];
            const result: DynamicRow[] = [];
            for (const id of linkedIds) {
              for (const apiKey of targets) {
                const tName = typeNames.get(apiKey);
                const rows = await runSql(
                  Effect.gen(function* () {
                    const s = yield* SqlClient.SqlClient;
                    return yield* s.unsafe<DynamicRow>(
                      `SELECT * FROM "content_${apiKey}" WHERE id = ?`, [id]
                    );
                  })
                );
                if (rows.length > 0) {
                  result.push({ ...deserializeRecord(rows[0]), __typename: tName ? `${tName}Record` : undefined });
                  break;
                }
              }
            }
            return result;
          };
        }
      } else {
        // Default camelCase -> snake_case resolver
        bmResolvers[gqlName] = (parent: DynamicRow) => {
          const rawVal = parent[f.api_key];
          // Parse JSON-stored fields
          const def = getRegistryDef(f.field_type);
          if (def?.graphqlType === "JSON" && typeof rawVal === "string") {
            try { return JSON.parse(rawVal); } catch { return rawVal; }
          }
          return rawVal;
        };
      }
    }

    resolvers[bmTypeName] = bmResolvers;
  }

  // --- Pre-compute per-field StructuredText union types ---
  // Maps model api_key + field api_key -> union type name (only for fields with block whitelists)
  const structuredTextFieldTypes = new Map<string, string>();

  // Iterate both content models and block models
  for (const model of [...models, ...blockModels]) {
    const fields = fieldsByModelId.get(model.id) ?? [];
    const modelTypeName = typeNames.get(model.api_key) ?? blockTypeNames.get(model.api_key);
    if (!modelTypeName) continue;

    for (const f of fields) {
      if (f.field_type !== "structured_text") continue;
      const whitelist = getBlockWhitelist(f.validators);
      if (!whitelist || whitelist.length === 0) continue;

      // Collect member type names for the union
      const memberTypeNames: string[] = [];
      for (const blockApiKey of whitelist) {
        const bmtn = blockTypeNames.get(blockApiKey);
        if (bmtn) memberTypeNames.push(bmtn);
      }
      if (memberTypeNames.length === 0) continue;

      const fieldPascal = toTypeName(f.api_key);
      const unionName = `${modelTypeName}${fieldPascal}Block`;
      const fieldTypeName = `${modelTypeName}${fieldPascal}Field`;

      // Generate union type
      typeDefs.push(`union ${unionName} = ${memberTypeNames.join(" | ")}`);

      // Generate per-field StructuredText type
      typeDefs.push(`type ${fieldTypeName} {\n  value: JSON!\n  blocks: [${unionName}!]!\n  inlineBlocks: [${unionName}!]!\n  links: [JSON!]!\n}`);

      // __resolveType for the union
      resolvers[unionName] = { __resolveType: (obj: DynamicRow) => obj.__typename as string };

      // Store mapping so the content/block model field uses this type
      structuredTextFieldTypes.set(`${model.api_key}.${f.api_key}`, fieldTypeName);
    }
  }

  // Now emit block model SDL (deferred so structured_text fields can use typed unions)
  for (const { bmApiKey, bmTypeName, bmFields } of deferredBlockModelSDL) {
    const bmFieldDefs = ["id: ID!", "_modelApiKey: String!"];
    for (const f of bmFields) {
      const stKey = `${bmApiKey}.${f.api_key}`;
      const stFieldType = structuredTextFieldTypes.get(stKey);
      const gqlType = stFieldType ?? fieldToSDL(f.field_type, f.validators, typeNames);
      bmFieldDefs.push(`${toCamelCase(f.api_key)}: ${gqlType}`);
    }
    typeDefs.push(`type ${bmTypeName} {\n  ${bmFieldDefs.join("\n  ")}\n}`);
  }

  return structuredTextFieldTypes;
}
