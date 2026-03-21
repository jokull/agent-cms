/**
 * Build reverse reference fields and resolvers.
 * For each target model with incoming link/links references, add _allReferencing<Source>s fields.
 */
import { getLinkTargets, getLinksTargets } from "../db/validators.js";
import { compileFilterToSql, compileOrderBy, type FilterCompilerOpts } from "./filter-compiler.js";
import type { ModelRow, ParsedFieldRow } from "../db/row-types.js";
import type { SchemaBuilderContext, ReverseRef, DynamicRow, GqlContext } from "./gql-types.js";
import { toTypeName, toCamelCase } from "./gql-utils.js";
import { loadReverseRefs } from "./reverse-ref-loader.js";

/**
 * Build the reverse reference map: target model api_key -> array of incoming link/links refs.
 */
export function buildReverseRefs(
  models: readonly ModelRow[],
  fieldsByModelId: Map<string, ParsedFieldRow[]>
): Map<string, ReverseRef[]> {
  const reverseRefs = new Map<string, ReverseRef[]>();

  for (const m of models) {
    const mFields = fieldsByModelId.get(m.id) ?? [];
    for (const f of mFields) {
      let targets: string[] | undefined;
      if (f.field_type === "link") {
        targets = getLinkTargets(f.validators);
      } else if (f.field_type === "links") {
        targets = getLinksTargets(f.validators);
      }
      if (!targets) continue;
      for (const targetApiKey of targets) {
        // Only add if target is a known content model
        const exists = models.some((mod) => mod.api_key === targetApiKey);
        if (!exists) continue;
        const arr = reverseRefs.get(targetApiKey) ?? [];
        arr.push({
          sourceModelApiKey: m.api_key,
          sourceTypeName: toTypeName(m.api_key),
          sourceTableName: `content_${m.api_key}`,
          fieldApiKey: f.api_key,
          fieldType: f.field_type,
        });
        reverseRefs.set(targetApiKey, arr);
      }
    }
  }

  return reverseRefs;
}

/**
 * Build reverse reference resolvers and extend target type SDL.
 */
function isFilterObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function buildReverseRefResolvers(
  ctx: SchemaBuilderContext,
  reverseRefs: Map<string, ReverseRef[]>
): void {
  const { models, fieldsByModelId, resolvers, typeDefs, runSql, defaultLocale } = ctx;

  for (const [targetApiKey, refs] of reverseRefs) {
    const targetTypeName = ctx.typeNames.get(targetApiKey) ?? toTypeName(targetApiKey);

    // Group refs by source model (multiple fields from same source model share one field)
    const bySource = new Map<string, ReverseRef[]>();
    for (const ref of refs) {
      const arr = bySource.get(ref.sourceModelApiKey) ?? [];
      arr.push(ref);
      bySource.set(ref.sourceModelApiKey, arr);
    }

    const extendFields: string[] = [];

    for (const [sourceApiKey, sourceRefs] of bySource) {
      const sourceTypeName = toTypeName(sourceApiKey);
      const fieldName = `_allReferencing${sourceTypeName}s`;
      const sourceRecordTypeName = ctx.typeNames.get(sourceApiKey) ?? sourceTypeName;
      extendFields.push(
        `${fieldName}(locale: SiteLocale, fallbackLocales: [SiteLocale!], filter: ${sourceTypeName}Filter, orderBy: [${sourceTypeName}OrderBy!], first: Int, skip: Int): [${sourceRecordTypeName}!]!`
      );

      const sourceTableName = sourceRefs[0].sourceTableName;

      // Build filter compiler opts for the source model
      const sourceModel = models.find((m) => m.api_key === sourceApiKey);
      if (!sourceModel) continue;
      const sourceFields = fieldsByModelId.get(sourceModel.id) ?? [];
      const sourceCamelToSnake = new Map<string, string>();
      const sourceLocalizedCamelKeys = new Set<string>();
      for (const sf of sourceFields) {
        sourceCamelToSnake.set(toCamelCase(sf.api_key), sf.api_key);
        if (sf.localized) sourceLocalizedCamelKeys.add(toCamelCase(sf.api_key));
      }
      const sourceJsonArrayFields = new Set(
        sourceFields.filter((sf) => sf.field_type === "links" || sf.field_type === "media_gallery")
          .map((sf) => toCamelCase(sf.api_key))
      );

      // Ensure resolver map exists for target type
      if (!resolvers[targetTypeName]) resolvers[targetTypeName] = {};

      (resolvers[targetTypeName])[fieldName] = async (parent: DynamicRow, args: DynamicRow, context: GqlContext) => {
        if (typeof args.locale === "string") context.locale = args.locale;
        if (Array.isArray(args.fallbackLocales)) {
          context.fallbackLocales = args.fallbackLocales.filter((value): value is string => typeof value === "string");
        }

        const includeDrafts = context.includeDrafts ?? false;
        const filterLocale = typeof args.locale === "string"
          ? args.locale
          : (context.locale ?? defaultLocale ?? undefined);
        const filterOpts: FilterCompilerOpts = {
          fieldIsLocalized: (fName) => sourceLocalizedCamelKeys.has(fName),
          fieldNameMap: Object.fromEntries(sourceCamelToSnake),
          localizedDbColumns: sourceFields.filter((sf) => sf.localized).map((sf) => sf.api_key),
          jsonArrayFields: sourceJsonArrayFields,
          locale: filterLocale ?? undefined,
        };
        const filterArg = isFilterObject(args.filter) ? args.filter : undefined;
        const orderByArg = Array.isArray(args.orderBy)
          ? args.orderBy.filter((value): value is string => typeof value === "string")
          : undefined;
        const compiled = compileFilterToSql(filterArg, filterOpts);
        const orderBy = compileOrderBy(orderByArg, filterOpts);
        const normalizedOrderBy = orderBy ?? undefined;
        const first = Math.min(typeof args.first === "number" ? args.first : 20, 500);
        const skip = typeof args.skip === "number" && args.skip > 0 ? args.skip : 0;
        const parentId = typeof parent.id === "string" ? parent.id : String(parent.id);
        const loaderKey = JSON.stringify({
          sourceTableName,
          targetApiKey,
          sourceApiKey,
          includeDrafts,
          locale: filterLocale ?? null,
          filterWhere: compiled?.where ?? null,
          filterParams: compiled?.params ?? [],
          orderBy: normalizedOrderBy ?? null,
          first,
          skip,
        });

        return loadReverseRefs({
          runSql,
          context,
          loaderKey,
          parentId,
          sourceTableName,
          sourceRefs,
          includeDrafts,
          filterWhere: compiled?.where,
          filterParams: compiled?.params ?? [],
          orderBy: normalizedOrderBy,
          first,
          skip,
        });
      };
    }

    if (extendFields.length > 0) {
      typeDefs.push(`extend type ${targetTypeName} {\n  ${extendFields.join("\n  ")}\n}`);
    }
  }
}
