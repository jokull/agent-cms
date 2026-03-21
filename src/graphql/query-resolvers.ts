/**
 * Build Query root field resolvers for content models:
 * list queries, single queries, meta queries, and filter/orderBy type defs.
 */
import { Effect } from "effect";
import { SqlClient } from "@effect/sql";
import { compileFilterToSql, compileOrderBy, type FilterCompilerOpts } from "./filter-compiler.js";
import { computeIsValid, findUniqueConstraintViolations, getBlockWhitelist } from "../db/validators.js";
import type { GraphQLResolveInfo } from "graphql";
import type { SchemaBuilderContext, ModelQueryMeta, DynamicRow, GqlContext } from "./gql-types.js";
import { toCamelCase, pluralize, getRegistryDef, deserializeRecord, decodeSnapshot } from "./gql-utils.js";
import { buildLinkPrefetchSpecs, collectSelectedFieldNames } from "./sqlite-json-prefetch.js";
import { materializeStructuredTextValues } from "../services/structured-text-service.js";
import { resolveStructuredTextValue } from "./structured-text-resolver.js";
import { decodeJsonIfString } from "../json.js";

/**
 * Build filter/orderBy type defs and Query resolvers for each content model.
 */
function pickLocalizedStructuredTextValue(rawValue: unknown, context: GqlContext, defaultLocale?: string | null) {
  if (rawValue === null || rawValue === undefined) return { locale: null, value: null };

  const localeMap = decodeJsonIfString(rawValue);
  if (typeof localeMap !== "object" || localeMap === null || Array.isArray(localeMap)) {
    return { locale: null, value: rawValue };
  }

  const locale = context.locale ?? defaultLocale;
  const fallbacks = context.fallbackLocales ?? [];

  if (locale) {
    const localeValue = Reflect.get(localeMap, locale);
    if (localeValue !== undefined && localeValue !== null && localeValue !== "") {
      return { locale, value: localeValue };
    }
  }

  for (const fallback of fallbacks) {
    const fallbackValue = Reflect.get(localeMap, fallback);
    if (fallbackValue !== undefined && fallbackValue !== null && fallbackValue !== "") {
      return { locale: fallback, value: fallbackValue };
    }
  }

  if (defaultLocale) {
    const defaultValue = Reflect.get(localeMap, defaultLocale);
    if (defaultValue !== undefined) {
      return { locale: defaultLocale, value: defaultValue };
    }
  }

  const firstEntry = Object.entries(localeMap)[0];
  return firstEntry ? { locale: firstEntry[0], value: firstEntry[1] } : { locale: null, value: null };
}

export function buildQueryResolvers(ctx: SchemaBuilderContext, modelMetas: ModelQueryMeta[]): void {
  const { resolvers, typeDefs, queryFieldDefs, runSql, defaultLocale } = ctx;

  for (const meta of modelMetas) {
    const { baseTypeName, typeName, tableName, model, camelToSnake, localizedCamelKeys, localizedDbColumns, jsonArrayFields, fields } = meta;

    // Filter/OrderBy/Meta types (all use camelCase field names)
    const filterFields = [
      "id: LinkFilter", "_status: StatusFilter",
      "_createdAt: DateTimeFilter", "_updatedAt: DateTimeFilter",
      "_publishedAt: DateTimeFilter", "_firstPublishedAt: DateTimeFilter",
      "_publicationScheduledAt: DateTimeFilter", "_unpublishingScheduledAt: DateTimeFilter",
    ];
    const orderByValues = [
      "_createdAt_ASC", "_createdAt_DESC", "_updatedAt_ASC", "_updatedAt_DESC",
      "_publishedAt_ASC", "_publishedAt_DESC", "_firstPublishedAt_ASC", "_firstPublishedAt_DESC",
      "_publicationScheduledAt_ASC", "_publicationScheduledAt_DESC",
      "_unpublishingScheduledAt_ASC", "_unpublishingScheduledAt_DESC",
    ];
    if (model.sortable || model.tree) {
      filterFields.push("_position: PositionFilter");
      orderByValues.push("_position_ASC", "_position_DESC");
    }
    if (model.tree) {
      filterFields.push("_parent: ParentFilter");
    }
    if (localizedCamelKeys.size > 0) {
      filterFields.push("_locales: LocalesFilter");
    }
    for (const f of fields) {
      const def = getRegistryDef(f.field_type);
      if (def?.filterType) {
        const gqlName = toCamelCase(f.api_key);
        filterFields.push(`${gqlName}: ${def.filterType}`);
        // Only add orderBy for scalar-ish fields (not arrays, objects, etc.)
        if (!["LinksFilter", "LatLonFilter", "ExistsFilter"].includes(def.filterType)) {
          orderByValues.push(`${gqlName}_ASC`, `${gqlName}_DESC`);
        }
      }
    }
    filterFields.push(`AND: [${baseTypeName}Filter!]`, `OR: [${baseTypeName}Filter!]`);
    typeDefs.push(`input ${baseTypeName}Filter {\n  ${filterFields.join("\n  ")}\n}`);
    typeDefs.push(`enum ${baseTypeName}OrderBy { ${orderByValues.join(" ")} }`);
    typeDefs.push(`type ${baseTypeName}Meta { count: Int! }`);

    // Queries (camelCase like DatoCMS: blogPost not blog_post)
    const listName = `all${pluralize(baseTypeName)}`;
    const singleName = toCamelCase(model.api_key);
    queryFieldDefs.push(`${listName}(locale: SiteLocale, fallbackLocales: [SiteLocale!], filter: ${baseTypeName}Filter, orderBy: [${baseTypeName}OrderBy!], first: Int, skip: Int, excludeInvalid: Boolean): [${typeName}!]!`);
    queryFieldDefs.push(`${singleName}(locale: SiteLocale, fallbackLocales: [SiteLocale!], id: ItemId, filter: ${baseTypeName}Filter): ${typeName}`);
    const metaName = `_all${pluralize(baseTypeName)}Meta`;
    queryFieldDefs.push(`${metaName}(filter: ${baseTypeName}Filter, excludeInvalid: Boolean): ${baseTypeName}Meta!`);

    // Build locale-awareness and camelCase->snake_case mapping for filter/order compilation
    const fieldNameMap = Object.fromEntries(camelToSnake);
    const fieldIsLocalized = (fieldName: string) => localizedCamelKeys.has(fieldName);
    const jsonObjectIdFields = new Set(
      fields.filter((f) => f.field_type === "media").map((f) => toCamelCase(f.api_key))
    );

    async function queryWithFilter(
      args: { filter?: DynamicRow; orderBy?: string[]; first?: number; skip?: number },
      includeDrafts: boolean,
      locale?: string,
      info?: GraphQLResolveInfo
    ): Promise<DynamicRow[]> {
      const filterLocale = locale ?? defaultLocale ?? undefined;
      const filterOpts: FilterCompilerOpts = {
        fieldIsLocalized,
        fieldNameMap,
        localizedDbColumns,
        jsonArrayFields,
        jsonObjectIdFields,
        locale: filterLocale,
      };

      return await runSql(
        Effect.gen(function* () {
          const s = yield* SqlClient.SqlClient;

          const linkPrefetchSpecs = info
            ? buildLinkPrefetchSpecs({ ctx, rootFields: fields, info, tableName })
            : [];
          const selectClause = linkPrefetchSpecs.length > 0
            ? `SELECT "${tableName}".*, ${linkPrefetchSpecs.map((spec) => spec.sqlExpression).join(", ")}`
            : `SELECT *`;
          let query = `${selectClause} FROM "${tableName}"`;
          const conditions: string[] = [];
          let params: unknown[] = [];

          // Draft filtering: without includeDrafts, only show published/updated
          if (!includeDrafts) {
            conditions.push(`"_status" IN ('published', 'updated')`);
          }

          // Compile user filter to SQL WHERE clause (locale-aware for localized fields)
          const compiled = compileFilterToSql(args.filter, filterOpts);
          if (compiled) {
            conditions.push(compiled.where);
            params = compiled.params;
          }

          if (conditions.length > 0) {
            query += ` WHERE ${conditions.join(" AND ")}`;
          }

          // Use explicit orderBy if provided, otherwise fall back to model's default ordering
          const effectiveOrderBy = args.orderBy ?? (model.ordering ? [model.ordering] : undefined);
          const orderBy = compileOrderBy(effectiveOrderBy, filterOpts);
          if (orderBy) {
            query += ` ORDER BY ${orderBy}`;
          }

          const limit = Math.min(args.first ?? 20, 500);
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
    }

    async function prefetchStructuredTextFields(
      records: DynamicRow[],
      includeDrafts: boolean,
      context: GqlContext,
      info: GraphQLResolveInfo
    ) {
      if (!includeDrafts || records.length === 0) return;

      const selectedFieldNames = collectSelectedFieldNames(info);
      const requests: Array<{
        requestKey: string;
        allowedBlockApiKeys?: readonly string[];
        parentContainerModelApiKey: string;
        parentBlockId: null;
        parentFieldApiKey: string;
        rootRecordId: string;
        rootFieldApiKey: string;
        rawValue: unknown;
      }> = [];
      const assignments: Array<{
        allowedBlockApiKeys: readonly string[];
        fieldApiKey: string;
        locale: string | null;
        localized: boolean;
        record: DynamicRow;
        requestKey: string;
        rootFieldApiKey: string;
      }> = [];

      for (const field of fields) {
        if (field.field_type !== "structured_text") continue;
        if (!selectedFieldNames.has(toCamelCase(field.api_key))) continue;

        const allowedBlockApiKeys = getBlockWhitelist(field.validators) ?? [];

        for (const record of records) {
          const selected = field.localized
            ? pickLocalizedStructuredTextValue(record[field.api_key], context, defaultLocale)
            : { locale: null, value: record[field.api_key] };
          const rawValue = selected.value;
          if (!rawValue) continue;
          if (typeof rawValue === "object" && rawValue !== null && !Array.isArray(rawValue)
            && "value" in rawValue && "blocks" in rawValue) {
            continue;
          }

          const rootFieldApiKey = field.localized
            ? `${field.api_key}:${selected.locale ?? defaultLocale ?? ""}`.replace(/:$/, "")
            : field.api_key;
          const requestKey = `${field.api_key}:${selected.locale ?? ""}:${record.id}`;
          requests.push({
            requestKey,
            allowedBlockApiKeys,
            parentContainerModelApiKey: model.api_key,
            parentBlockId: null,
            parentFieldApiKey: field.api_key,
            rootRecordId: String(record.id),
            rootFieldApiKey,
            rawValue,
          });
          assignments.push({
            allowedBlockApiKeys,
            fieldApiKey: field.api_key,
            locale: selected.locale,
            localized: Boolean(field.localized),
            record,
            requestKey,
            rootFieldApiKey,
          });
        }
      }

      if (requests.length === 0) return;

      const materialized = await runSql(materializeStructuredTextValues({ requests }));
      const prefetchedResults = await Promise.all(assignments.map(async (assignment) => {
        const envelope = materialized.get(assignment.requestKey);
        if (!envelope) return null;
        if (assignment.localized && assignment.locale) {
          const existing = assignment.record[assignment.fieldApiKey];
          if (typeof existing === "object" && existing !== null && !Array.isArray(existing)) {
            Reflect.set(existing, assignment.locale, envelope);
          }
        } else {
          assignment.record[assignment.fieldApiKey] = envelope;
        }

        const resolved = await resolveStructuredTextValue({
          runSql,
          rawValue: envelope,
          rootRecordId: String(assignment.record.id),
          rootFieldApiKey: assignment.rootFieldApiKey,
          parentContainerModelApiKey: model.api_key,
          parentBlockId: null,
          parentFieldApiKey: assignment.fieldApiKey,
          models: ctx.models,
          blockModels: ctx.blockModels,
          allowedBlockApiKeys: assignment.allowedBlockApiKeys,
          typeNames: ctx.typeNames,
          includeDrafts,
          linkedRecordCache: context.linkedRecordCache,
          context,
        });
        return { assignment, resolved };
      }));

      for (const prefetched of prefetchedResults) {
        if (!prefetched?.resolved) continue;
        prefetched.assignment.record[`__prefetch_st_${prefetched.assignment.fieldApiKey}`] = prefetched.resolved;
      }
    }

    async function countWithFilter(filter: DynamicRow | undefined, includeDrafts: boolean): Promise<number> {
      return await runSql(
        Effect.gen(function* () {
          const s = yield* SqlClient.SqlClient;

          let query = `SELECT COUNT(*) as count FROM "${tableName}"`;
          const conditions: string[] = [];
          let params: unknown[] = [];

          if (!includeDrafts) {
            conditions.push(`"_status" IN ('published', 'updated')`);
          }

          const compiled = compileFilterToSql(filter, {
            fieldIsLocalized,
            fieldNameMap,
            localizedDbColumns,
            jsonArrayFields,
            jsonObjectIdFields,
          });
          if (compiled) {
            conditions.push(compiled.where);
            params = compiled.params;
          }

          if (conditions.length > 0) {
            query += ` WHERE ${conditions.join(" AND ")}`;
          }

          const rows = yield* s.unsafe<{ count: number }>(query, params);
          return rows[0]?.count ?? 0;
        })
      );
    }

    (resolvers.Query)[listName] = async (_: unknown, args: DynamicRow, context: GqlContext, info: GraphQLResolveInfo) => {
      const includeDrafts = context.includeDrafts ?? false;
      const excludeInvalid = typeof args.excludeInvalid === "boolean"
        ? args.excludeInvalid
        : (context.excludeInvalid ?? false);
      const locale = typeof args.locale === "string"
        ? args.locale
        : (context.locale ?? defaultLocale ?? undefined);
      // Store locale for nested field resolvers (per-query, not shared across root fields)
      if (args.locale) context.locale = args.locale as string;
      if (args.fallbackLocales) context.fallbackLocales = args.fallbackLocales as string[];
      let results = await queryWithFilter(
        args as { filter?: DynamicRow; orderBy?: string[]; first?: number; skip?: number },
        includeDrafts,
        locale,
        info
      );
      await prefetchStructuredTextFields(results, includeDrafts, context, info);
      if (excludeInvalid) {
        const validity = await Promise.all(results.map(async (record) => {
          const required = computeIsValid(record, fields, defaultLocale);
          if (!required.valid) return false;
          const uniqueViolations = await runSql(findUniqueConstraintViolations({
            tableName,
            record,
            fields,
            excludeId: typeof record.id === "string" ? record.id : null,
          }));
          return uniqueViolations.length === 0;
        }));
        results = results.filter((_, index) => validity[index]);
      }
      return results;
    };

    (resolvers.Query)[singleName] = async (_: unknown, args: DynamicRow, context: GqlContext, info: GraphQLResolveInfo) => {
      const includeDrafts = context.includeDrafts ?? false;
      const locale = typeof args.locale === "string"
        ? args.locale
        : (context.locale ?? defaultLocale ?? undefined);
      if (args.locale) context.locale = args.locale as string;
      if (args.fallbackLocales) context.fallbackLocales = args.fallbackLocales as string[];
      if (args.id) {
        return await runSql(
          Effect.gen(function* () {
            const s = yield* SqlClient.SqlClient;
            const conditions = [`id = ?`];
            if (!includeDrafts) conditions.push(`"_status" IN ('published', 'updated')`);
            const linkPrefetchSpecs = buildLinkPrefetchSpecs({ ctx, rootFields: fields, info, tableName });
            const selectClause = linkPrefetchSpecs.length > 0
              ? `SELECT "${tableName}".*, ${linkPrefetchSpecs.map((spec) => spec.sqlExpression).join(", ")}`
              : `SELECT *`;
            const rows = yield* s.unsafe<DynamicRow>(
              `${selectClause} FROM "${tableName}" WHERE ${conditions.join(" AND ")}`,
              [args.id]
            );
            if (rows.length === 0) return null;
            return decodeSnapshot(deserializeRecord(rows[0]), includeDrafts);
          })
        ).then(async (record) => {
          if (record) await prefetchStructuredTextFields([record], includeDrafts, context, info);
          return record;
        });
      }
      if (args.filter) {
        const records = await queryWithFilter(
          { filter: args.filter as DynamicRow, first: 1 },
          includeDrafts,
          locale,
          info
        );
        await prefetchStructuredTextFields(records, includeDrafts, context, info);
        return records[0] ?? null;
      }
      // Singleton models: return the single record without arguments
      if (model.singleton) {
        const records = await queryWithFilter({ first: 1 }, includeDrafts, locale, info);
        await prefetchStructuredTextFields(records, includeDrafts, context, info);
        return records[0] ?? null;
      }
      return null;
    };

    (resolvers.Query)[metaName] = async (_: unknown, args: DynamicRow, context: GqlContext) => {
      const includeDrafts = context.includeDrafts ?? false;
      const excludeInvalid = typeof args.excludeInvalid === "boolean"
        ? args.excludeInvalid
        : (context.excludeInvalid ?? false);
      if (excludeInvalid) {
        // Need to fetch all records and filter in JS for accurate count
        const allRecords = await queryWithFilter(
          { filter: args.filter as DynamicRow, first: 500 },
          includeDrafts
        );
        const validity = await Promise.all(allRecords.map(async (record) => {
          const required = computeIsValid(record, fields, defaultLocale);
          if (!required.valid) return false;
          const uniqueViolations = await runSql(findUniqueConstraintViolations({
            tableName,
            record,
            fields,
            excludeId: typeof record.id === "string" ? record.id : null,
          }));
          return uniqueViolations.length === 0;
        }));
        const validCount = validity.filter(Boolean).length;
        return { count: validCount };
      }
      return { count: countWithFilter(args.filter as DynamicRow | undefined, includeDrafts) };
    };
  }
}
