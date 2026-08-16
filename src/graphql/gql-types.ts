/**
 * Shared types for the GraphQL schema builder modules.
 */
import type { Effect } from "effect";
import type { SqlClient } from "effect/unstable/sql";
import type { ModelRow, ParsedFieldRow } from "../db/row-types.js";

/** The minimal DAST document shape expected by extract*Ids helpers */
export type DastDocInput = { document: { children: readonly unknown[] } };

import type { DynamicRow, StoredFieldValue } from "../dynamic/row-types.js";

/**
 * A value as it appears in GraphQL query variables or argument ASTs: a stored
 * field value, or a (possibly nested, possibly sparse) array of the same.
 */
export type QueryVariableValue = StoredFieldValue | readonly (QueryVariableValue | undefined)[];

/** GraphQL resolver context passed through from Yoga */
export interface GqlContext {
  includeDrafts?: boolean;
  excludeInvalid?: boolean;
  locale?: string;
  fallbackLocales?: string[];
  linkedRecordCache?: Map<string, Promise<DynamicRow | null>>;
}

/** Resolved asset object returned by GraphQL */
export interface AssetObject {
  id: string;
  filename: string;
  mimeType: string;
  size: number;
  width: number | null;
  height: number | null;
  alt: string | null;
  title: string | null;
  blurhash: string | null;
  focalPoint: { x: number; y: number } | null;
  customData: DynamicRow | null;
  tags: string[];
  url: string;
  _createdAt: string;
  _updatedAt: string;
  _createdBy: string | null;
  _updatedBy: string | null;
}

/** Describes an incoming link/links reference from another model */
export interface ReverseRef {
  sourceModelApiKey: string;
  sourceTypeName: string;
  sourceTableName: string;
  fieldApiKey: string;
  fieldType: string;
}

/** Per-model metadata collected during schema building */
export interface ModelQueryMeta {
  baseTypeName: string;
  typeName: string;
  tableName: string;
  model: ModelRow;
  camelToSnake: Map<string, string>;
  localizedCamelKeys: Set<string>;
  localizedDbColumns: string[];
  jsonArrayFields: Set<string>;
  fields: ParsedFieldRow[];
}

/** The shared context passed between schema builder sub-modules */
export interface SchemaBuilderContext {
  runSql: <A>(effect: Effect.Effect<A, unknown, SqlClient.SqlClient>) => Promise<A>;
  assetUrl: (r2Key: string) => string;
  cfImageUrl: (assetPath: string, params: Record<string, string | number>) => string;
  models: readonly ModelRow[];
  blockModels: readonly ModelRow[];
  fieldsByModelId: Map<string, ParsedFieldRow[]>;
  typeNames: Map<string, string>;
  blockTypeNames: Map<string, string>;
  defaultLocale: string | null;
  locales: ReadonlyArray<{ code: string; position: number; fallback_locale_id: string | null }>;
  resolvers: Record<string, DynamicRow>;
  typeDefs: string[];
  queryFieldDefs: string[];
  isProduction?: boolean;
}

/** Options for buildGraphQLSchema */
export interface SchemaBuilderOptions {
  assetBaseUrl?: string;
  /** Path prefix for asset URLs. Default: "/assets/{id}" which produces /assets/{id}/{filename}.
   *  Set to "" for flat R2 storage (produces /{filename}).
   *  Use "{id}" placeholder for the asset ID if needed. */
  assetPathPrefix?: string;
  isProduction?: boolean;
}
