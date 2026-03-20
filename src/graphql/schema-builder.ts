/**
 * GraphQL schema builder — thin orchestrator.
 * Loads CMS metadata, builds context, and delegates to sub-modules.
 */
import { createSchema } from "graphql-yoga";
import { GraphQLScalarType, Kind } from "graphql";
import { Effect, Layer } from "effect";
import { SqlClient } from "@effect/sql";
import type { ModelRow, FieldRow } from "../db/row-types.js";
import { parseFieldValidators } from "../db/row-types.js";
import type { SchemaBuilderContext, SchemaBuilderOptions } from "./gql-types.js";
import { toContentTypeName, toTypeName } from "./gql-utils.js";
import { BASE_TYPE_DEFS } from "./sdl-constants.js";
import { buildBlockModelResolvers } from "./block-resolvers.js";
import { buildContentModelResolvers } from "./content-resolvers.js";
import { buildQueryResolvers } from "./query-resolvers.js";
import { buildReverseRefs, buildReverseRefResolvers } from "./reverse-ref-resolvers.js";
import { buildAssetResolvers } from "./asset-resolvers.js";
import { recordSqlMetrics } from "./sql-metrics.js";
import { encodeJson } from "../json.js";

function serializeGraphqlScalar(value: unknown): string | null {
  if (value == null) return null;
  if (typeof value === "string") return value;
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  return encodeJson(value);
}

const GraphQLItemId = new GraphQLScalarType({
  name: "ItemId",
  serialize(value) {
    return serializeGraphqlScalar(value);
  },
  parseValue(value) {
    return serializeGraphqlScalar(value);
  },
  parseLiteral(ast) {
    if (ast.kind === Kind.STRING || ast.kind === Kind.INT) {
      return ast.value;
    }
    return null;
  },
});

const GraphQLSiteLocale = new GraphQLScalarType({
  name: "SiteLocale",
  serialize(value) {
    return serializeGraphqlScalar(value);
  },
  parseValue(value) {
    return serializeGraphqlScalar(value);
  },
  parseLiteral(ast) {
    if (ast.kind === Kind.STRING || ast.kind === Kind.ENUM) {
      return ast.value;
    }
    return null;
  },
});

// Re-export for handler.ts compatibility
export type { SchemaBuilderOptions } from "./gql-types.js";

export function buildGraphQLSchema(sqlLayer: Layer.Layer<SqlClient.SqlClient>, options?: SchemaBuilderOptions) {
  /** Run an Effect requiring SqlClient, converting to Promise for GraphQL resolvers */
  function runSql<A>(effect: Effect.Effect<A, unknown, SqlClient.SqlClient>): Promise<A> {
    const startedAt = performance.now();
    return Effect.runPromise(effect.pipe(Effect.provide(sqlLayer), Effect.orDie)).finally(() => {
      recordSqlMetrics(performance.now() - startedAt);
    });
  }

  return Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;

    // Asset URL helpers
    const assetBase = (options?.assetBaseUrl ?? "").replace(/\/$/, "");

    function assetUrl(r2Key: string): string {
      return `${assetBase}/${r2Key}`;
    }

    function cfImageUrl(assetPath: string, params: Record<string, string | number>): string {
      if (options?.isProduction) {
        const opts = Object.entries(params).map(([k, v]) => `${k}=${v}`).join(",");
        return `${assetBase}/cdn-cgi/image/${opts}${assetPath}`;
      }
      const qs = Object.entries(params).map(([k, v]) => `${k}=${v}`).join("&");
      return `${assetBase}${assetPath}?${qs}`;
    }

    // Load all models and fields with typed rows
    const models = yield* sql.unsafe<ModelRow>("SELECT * FROM models WHERE is_block = 0 ORDER BY created_at");
    const blockModels = yield* sql.unsafe<ModelRow>("SELECT * FROM models WHERE is_block = 1");
    const allFields = yield* sql.unsafe<FieldRow>("SELECT * FROM fields ORDER BY position");

    // Group fields by model, parsing validators
    const fieldsByModelId = new Map<string, ReturnType<typeof parseFieldValidators>[]>();
    for (const f of allFields) {
      const list = fieldsByModelId.get(f.model_id) ?? [];
      list.push(parseFieldValidators(f));
      fieldsByModelId.set(f.model_id, list);
    }

    // Index creation/backfills happen during migrations and schema mutation flows.
    // Keep GraphQL schema construction read-only so cold requests don't pay DDL costs.

    // Load locales
    const locales = yield* sql.unsafe<{ code: string; position: number; fallback_locale_id: string | null }>(
      "SELECT code, position, fallback_locale_id FROM locales ORDER BY position"
    );
    const defaultLocale = locales.length > 0 ? locales[0].code : null;

    // Collect type names
    const typeNames = new Map<string, string>();
    for (const m of models) typeNames.set(m.api_key, toContentTypeName(m.api_key));

    const blockTypeNames = new Map<string, string>();
    for (const bm of blockModels) {
      blockTypeNames.set(bm.api_key, `${toTypeName(bm.api_key)}Record`);
    }

    // Initialize shared state
    const typeDefs: string[] = [];
    const queryFieldDefs: string[] = [];
    const resolvers: Record<string, Record<string, unknown>> = { Query: {} };

    typeDefs.push(BASE_TYPE_DEFS);
    if (locales.length > 0) {
      typeDefs.push(`enum SiteLocale { ${locales.map((locale) => locale.code).join(" ")} }`);
    } else {
      typeDefs.push("scalar SiteLocale");
    }

    // Build the shared context
    const ctx: SchemaBuilderContext = {
      runSql, assetUrl, cfImageUrl,
      models, blockModels, fieldsByModelId,
      typeNames, blockTypeNames,
      defaultLocale, locales,
      resolvers, typeDefs, queryFieldDefs,
      isProduction: options?.isProduction,
    };

    // 1. Block models + structured text unions
    const structuredTextFieldTypes = buildBlockModelResolvers(ctx);

    // 2. Content model types + field resolvers
    const modelMetas = buildContentModelResolvers(ctx, structuredTextFieldTypes);

    // 3. Query resolvers (filter/orderBy/list/single/meta)
    buildQueryResolvers(ctx, modelMetas);

    // 4. Reverse reference resolvers
    const reverseRefs = buildReverseRefs(models, fieldsByModelId);
    buildReverseRefResolvers(ctx, reverseRefs);

    // 5. Asset resolvers (uploads, responsive image, SEO image, color hex, _site)
    buildAssetResolvers(ctx);

    // Fallback for empty schema
    if (queryFieldDefs.length === 0) {
      queryFieldDefs.push("_empty: String");
      (resolvers.Query)._empty = () => null;
    }

    return createSchema({
      typeDefs: `${typeDefs.join("\n\n")}\ntype Query {\n  ${queryFieldDefs.join("\n  ")}\n}`,
      resolvers: {
        ...resolvers,
        ItemId: GraphQLItemId,
        ...(locales.length > 0 ? {} : { SiteLocale: GraphQLSiteLocale }),
      },
    });
  });
}
