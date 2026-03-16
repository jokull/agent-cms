/**
 * Build Query root field resolvers for content models:
 * list queries, single queries, meta queries, and filter/orderBy type defs.
 */
import { Effect } from "effect";
import { SqlClient } from "@effect/sql";
import { compileFilterToSql, compileOrderBy, type FilterCompilerOpts } from "./filter-compiler.js";
import type { SchemaBuilderContext, ModelQueryMeta, DynamicRow, GqlContext } from "./gql-types.js";
import { toTypeName, toCamelCase, getRegistryDef, deserializeRecord } from "./gql-utils.js";

/**
 * Build filter/orderBy type defs and Query resolvers for each content model.
 */
export function buildQueryResolvers(ctx: SchemaBuilderContext, modelMetas: ModelQueryMeta[]): void {
  const { resolvers, typeDefs, queryFieldDefs, runSql, defaultLocale } = ctx;

  for (const meta of modelMetas) {
    const { typeName, tableName, model, camelToSnake, localizedCamelKeys, localizedDbColumns, jsonArrayFields, fields } = meta;

    // Filter/OrderBy/Meta types (all use camelCase field names)
    const filterFields = [
      "id: StringFilter", "_status: StringFilter",
      "_createdAt: DateTimeFilter", "_updatedAt: DateTimeFilter",
      "_publishedAt: DateTimeFilter", "_firstPublishedAt: DateTimeFilter",
    ];
    const orderByValues = [
      "_createdAt_ASC", "_createdAt_DESC", "_updatedAt_ASC", "_updatedAt_DESC",
      "_publishedAt_ASC", "_publishedAt_DESC", "_firstPublishedAt_ASC", "_firstPublishedAt_DESC",
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
    filterFields.push(`AND: [${typeName}Filter!]`, `OR: [${typeName}Filter!]`);
    typeDefs.push(`input ${typeName}Filter {\n  ${filterFields.join("\n  ")}\n}`);
    typeDefs.push(`enum ${typeName}OrderBy { ${orderByValues.join(" ")} }`);
    typeDefs.push(`type ${typeName}Meta { count: Int! }`);

    // Queries (camelCase like DatoCMS: blogPost not blog_post)
    const listName = `all${typeName}s`;
    const singleName = toCamelCase(model.api_key);
    queryFieldDefs.push(`${listName}(locale: String, fallbackLocales: [String!], filter: ${typeName}Filter, orderBy: [${typeName}OrderBy!], first: Int, skip: Int): [${typeName}!]!`);
    queryFieldDefs.push(`${singleName}(locale: String, fallbackLocales: [String!], id: ID, filter: ${typeName}Filter): ${typeName}`);
    queryFieldDefs.push(`_all${typeName}sMeta(filter: ${typeName}Filter): ${typeName}Meta!`);

    // Build locale-awareness and camelCase->snake_case mapping for filter/order compilation
    const fieldNameMap = Object.fromEntries(camelToSnake);
    const fieldIsLocalized = (fieldName: string) => localizedCamelKeys.has(fieldName);

    async function queryWithFilter(
      args: { filter?: DynamicRow; orderBy?: string[]; first?: number; skip?: number },
      includeDrafts: boolean,
      locale?: string
    ): Promise<DynamicRow[]> {
      const filterLocale = locale ?? defaultLocale ?? undefined;
      const filterOpts: FilterCompilerOpts = {
        fieldIsLocalized,
        fieldNameMap,
        localizedDbColumns,
        jsonArrayFields,
        locale: filterLocale,
      };

      return await runSql(
        Effect.gen(function* () {
          const s = yield* SqlClient.SqlClient;

          let query = `SELECT * FROM "${tableName}"`;
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

          const orderBy = compileOrderBy(args.orderBy, filterOpts);
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
          return rows.map((row) => {
            const deserialized = deserializeRecord(row);
            // When not including drafts, overlay published snapshot values
            if (!includeDrafts && deserialized._published_snapshot) {
              const snapshot = typeof deserialized._published_snapshot === "string"
                ? JSON.parse(deserialized._published_snapshot as string)
                : deserialized._published_snapshot;
              return { ...deserialized, ...(snapshot as DynamicRow) };
            }
            return deserialized;
          });
        })
      );
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

    (resolvers.Query as Record<string, unknown>)[listName] = (_: unknown, args: DynamicRow, context: GqlContext) => {
      const includeDrafts = context?.includeDrafts ?? false;
      const locale = (args.locale as string) ?? context?.locale ?? defaultLocale;
      // Store locale for nested field resolvers (per-query, not shared across root fields)
      if (args.locale) context.locale = args.locale as string;
      if (args.fallbackLocales) context.fallbackLocales = args.fallbackLocales as string[];
      return queryWithFilter(
        args as { filter?: DynamicRow; orderBy?: string[]; first?: number; skip?: number },
        includeDrafts,
        locale ?? undefined
      );
    };

    (resolvers.Query as Record<string, unknown>)[singleName] = async (_: unknown, args: DynamicRow, context: GqlContext) => {
      const includeDrafts = context?.includeDrafts ?? false;
      const locale = (args.locale as string) ?? context?.locale ?? defaultLocale;
      if (args.locale) context.locale = args.locale as string;
      if (args.fallbackLocales) context.fallbackLocales = args.fallbackLocales as string[];
      if (args.id) {
        return await runSql(
          Effect.gen(function* () {
            const s = yield* SqlClient.SqlClient;
            const conditions = [`id = ?`];
            if (!includeDrafts) conditions.push(`"_status" IN ('published', 'updated')`);
            const rows = yield* s.unsafe<DynamicRow>(
              `SELECT * FROM "${tableName}" WHERE ${conditions.join(" AND ")}`,
              [args.id]
            );
            if (rows.length === 0) return null;
            const deserialized = deserializeRecord(rows[0]);
            if (!includeDrafts && deserialized._published_snapshot) {
              const snapshot = typeof deserialized._published_snapshot === "string"
                ? JSON.parse(deserialized._published_snapshot as string)
                : deserialized._published_snapshot;
              return { ...deserialized, ...(snapshot as DynamicRow) };
            }
            return deserialized;
          })
        );
      }
      if (args.filter) {
        const records = await queryWithFilter(
          { filter: args.filter as DynamicRow, first: 1 },
          includeDrafts,
          locale ?? undefined
        );
        return records[0] ?? null;
      }
      // Singleton models: return the single record without arguments
      if (model.singleton) {
        const records = await queryWithFilter({ first: 1 }, includeDrafts, locale ?? undefined);
        return records[0] ?? null;
      }
      return null;
    };

    (resolvers.Query as Record<string, unknown>)[`_all${typeName}sMeta`] = (_: unknown, args: DynamicRow, context: GqlContext) => {
      const includeDrafts = context?.includeDrafts ?? false;
      return { count: countWithFilter(args.filter as DynamicRow | undefined, includeDrafts) };
    };
  }
}
