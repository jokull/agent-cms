/**
 * Build reverse reference fields and resolvers.
 * For each target model with incoming link/links references, add _allReferencing<Source>s fields.
 */
import { Effect } from "effect";
import { SqlClient } from "@effect/sql";
import { getLinkTargets, getLinksTargets } from "../db/validators.js";
import { compileFilterToSql, compileOrderBy, type FilterCompilerOpts } from "./filter-compiler.js";
import type { ModelRow, ParsedFieldRow } from "../db/row-types.js";
import type { SchemaBuilderContext, ReverseRef, DynamicRow, GqlContext } from "./gql-types.js";
import { toTypeName, toCamelCase, deserializeRecord, decodeSnapshot } from "./gql-utils.js";

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
        // Propagate locale/fallbackLocales from args to context for nested resolvers
        if (typeof args.locale === "string") context.locale = args.locale;
        if (Array.isArray(args.fallbackLocales)) context.fallbackLocales = args.fallbackLocales;

        return runSql(
          Effect.gen(function* () {
            const s = yield* SqlClient.SqlClient;

            // Build WHERE clause: any link/links field pointing at this record
            const refConditions: string[] = [];
            const refParams: unknown[] = [];

            for (const ref of sourceRefs) {
              if (ref.fieldType === "link") {
                refConditions.push(`"${ref.fieldApiKey}" = ?`);
                refParams.push(parent.id);
              } else {
                // links: JSON array - use json_each to check membership
                refConditions.push(`EXISTS (SELECT 1 FROM json_each("${ref.fieldApiKey}") WHERE value = ?)`);
                refParams.push(parent.id);
              }
            }

            let query = `SELECT * FROM "${sourceTableName}" WHERE (${refConditions.join(" OR ")})`;
            let params = [...refParams];

            // Draft filtering
            const includeDrafts = context.includeDrafts ?? false;
            if (!includeDrafts) {
              query += ` AND "_status" IN ('published', 'updated')`;
            }

            // Apply user filter
            const filterLocale = typeof args.locale === "string"
              ? args.locale
              : (context.locale ?? defaultLocale ?? undefined);
            const filterOpts: FilterCompilerOpts = {
              fieldIsLocalized: (fName) => sourceLocalizedCamelKeys.has(fName),
              fieldNameMap: Object.fromEntries(sourceCamelToSnake),
              localizedDbColumns: sourceFields.filter((sf) => sf.localized).map((sf) => sf.api_key),
              jsonArrayFields: sourceJsonArrayFields,
              locale: filterLocale,
            };

            const compiled = compileFilterToSql(args.filter as DynamicRow | undefined, filterOpts);
            if (compiled) {
              query += ` AND ${compiled.where}`;
              params.push(...compiled.params);
            }

            const orderBy = compileOrderBy(args.orderBy as string[] | undefined, filterOpts);
            if (orderBy) {
              query += ` ORDER BY ${orderBy}`;
            }

            const limit = Math.min(typeof args.first === "number" ? args.first : 20, 500);
            query += ` LIMIT ?`;
            params.push(limit);

            if (args.skip) {
              query += ` OFFSET ?`;
              params.push(args.skip);
            }

            const rows = yield* s.unsafe<DynamicRow>(query, params);
            return rows.map((row) => decodeSnapshot(deserializeRecord(row), includeDrafts));
          })
        );
      };
    }

    if (extendFields.length > 0) {
      typeDefs.push(`extend type ${targetTypeName} {\n  ${extendFields.join("\n  ")}\n}`);
    }
  }
}
