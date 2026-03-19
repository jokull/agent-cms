/**
 * Build GraphQL types and resolvers for block models.
 * Also computes per-field StructuredText union types.
 */
import { Effect } from "effect";
import { SqlClient } from "@effect/sql";
import type { AssetRow } from "../db/row-types.js";
import { getLinkTargets, getLinksTargets, getBlockWhitelist } from "../db/validators.js";
import type { SchemaBuilderContext, DynamicRow, GqlContext } from "./gql-types.js";
import { toTypeName, toCamelCase, fieldToSDL, getRegistryDef, resolveVideoField } from "./gql-utils.js";
import { resolveStructuredTextValue } from "./structured-text-resolver.js";
import { loadLinkedRecords } from "./linked-record-loader.js";
import { decodeJsonIfString, decodeJsonStringOr } from "../json.js";

function pickLocalizedEntry(rawValue: unknown, context: GqlContext) {
  if (rawValue === null || rawValue === undefined) return { locale: null, value: null };
  const localeMap = decodeJsonIfString(rawValue);
  if (typeof localeMap !== "object" || localeMap === null || Array.isArray(localeMap)) {
    return { locale: null, value: rawValue };
  }

  const locMap = localeMap as Record<string, unknown>;
  const locale = context.locale ?? null;
  const fallbacks = context.fallbackLocales ?? [];
  if (locale && locMap[locale] !== undefined && locMap[locale] !== null && locMap[locale] !== "") {
    return { locale, value: locMap[locale] };
  }
  for (const fb of fallbacks) {
    if (locMap[fb] !== undefined && locMap[fb] !== null && locMap[fb] !== "") {
      return { locale: fb, value: locMap[fb] };
    }
  }
  const [firstLocale, firstValue] = Object.entries(locMap)[0] ?? [null, null];
  return { locale: firstLocale, value: firstValue };
}

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
            customData: a.custom_data ? decodeJsonStringOr(a.custom_data, null) : null,
            url: assetUrl(a.id, a.filename),
            _createdAt: a.created_at,
            _updatedAt: a.updated_at,
            _createdBy: a.created_by,
            _updatedBy: a.updated_by,
          };
        };
      } else if (f.field_type === "link") {
        const targets = getLinkTargets(f.validators);
        if (targets && targets.length > 0) {
          bmResolvers[gqlName] = async (parent: DynamicRow, _args: unknown, context: GqlContext) => {
            const linkedId = parent[f.api_key];
            if (!linkedId) return null;
            const resolved = await loadLinkedRecords({
              runSql,
              targetApiKeys: targets,
              ids: [linkedId as string],
              typeNames,
              includeDrafts: context.includeDrafts ?? false,
              context,
            });
            return resolved.get(linkedId as string) ?? null;
          };
        }
      } else if (f.field_type === "structured_text") {
        bmResolvers[gqlName] = async (parent: DynamicRow, _args: unknown, context: GqlContext) => {
          const localized = f.localized
            ? pickLocalizedEntry(parent[f.api_key], context)
            : { locale: null, value: parent[f.api_key] };
          const raw = localized.value;
          if (!raw) return null;
          return await resolveStructuredTextValue({
            runSql,
            rawValue: raw,
            rootRecordId: typeof parent._root_record_id === "string" ? parent._root_record_id : undefined,
            rootFieldApiKey: typeof parent._root_field_api_key === "string"
              ? parent._root_field_api_key
              : undefined,
            parentContainerModelApiKey: bm.api_key,
            parentBlockId: String(parent.id),
            parentFieldApiKey: f.api_key,
            models,
            blockModels,
            allowedBlockApiKeys: getBlockWhitelist(f.validators),
            typeNames,
            includeDrafts: context.includeDrafts ?? false,
            linkedRecordCache: context.linkedRecordCache,
          });
        };
      } else if (f.field_type === "links") {
        const targets = getLinksTargets(f.validators);
        if (targets && targets.length > 0) {
          bmResolvers[gqlName] = async (parent: DynamicRow, _args: unknown, context: GqlContext) => {
            let linkedIds = parent[f.api_key];
            linkedIds = decodeJsonIfString(linkedIds);
            if (!Array.isArray(linkedIds)) return [];
            const resolved = await loadLinkedRecords({
              runSql,
              targetApiKeys: targets,
              ids: linkedIds as string[],
              typeNames,
              includeDrafts: context.includeDrafts ?? false,
              context,
            });
            return (linkedIds as string[]).map((id) => resolved.get(id) ?? null).filter(Boolean);
          };
        }
      } else if (f.field_type === "video") {
        bmResolvers[gqlName] = (parent: DynamicRow) => resolveVideoField(parent[f.api_key]);
      } else {
        // Default camelCase -> snake_case resolver
        bmResolvers[gqlName] = (parent: DynamicRow) => {
          const rawVal = parent[f.api_key];
          // Parse JSON-stored fields
          const def = getRegistryDef(f.field_type);
          if (def?.graphqlType === "JSON" && typeof rawVal === "string") {
            return decodeJsonStringOr(rawVal, rawVal);
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
