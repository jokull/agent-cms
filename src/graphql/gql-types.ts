/**
 * Shared types for the GraphQL schema builder modules.
 */
import type { Effect } from "effect";
import type { SqlClient } from "@effect/sql";
import type { ModelRow, ParsedFieldRow } from "../db/row-types.js";

/** A dynamic row from a content/block table */
export type DynamicRow = Record<string, unknown>;

/** The minimal DAST document shape expected by extract*Ids helpers */
export type DastDocInput = { document: { children: readonly unknown[] } };

/** GraphQL resolver context passed through from Yoga */
export interface GqlContext {
  includeDrafts?: boolean;
  excludeInvalid?: boolean;
  locale?: string;
  fallbackLocales?: string[];
  linkedRecordCache?: Map<string, Promise<DynamicRow | null>>;
  linkedRecordLoaders?: Map<string, {
    cache: Map<string, Promise<DynamicRow | null>>;
    pending: Map<string, {
      promise: Promise<DynamicRow | null>;
      resolve: (value: DynamicRow | null) => void;
      reject: (error: unknown) => void;
    }>;
    scheduled: boolean;
  }>;
  structuredTextEnvelopeLoaders?: Map<string, {
    cache: Map<string, Promise<unknown>>;
    pending: Map<string, {
      deferred: {
        promise: Promise<unknown>;
        resolve: (value: unknown) => void;
        reject: (error: unknown) => void;
      };
      params: {
        allowedBlockApiKeys?: readonly string[];
        parentContainerModelApiKey: string;
        parentBlockId: string | null;
        parentFieldApiKey: string;
        rootRecordId: string;
        rootFieldApiKey: string;
        rawValue: unknown;
      };
    }>;
    scheduled: boolean;
  }>;
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
  customData: Record<string, string> | null;
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
  assetUrl: (id: string, filename: string) => string;
  cfImageUrl: (assetPath: string, params: Record<string, string | number>) => string;
  models: readonly ModelRow[];
  blockModels: readonly ModelRow[];
  fieldsByModelId: Map<string, ParsedFieldRow[]>;
  typeNames: Map<string, string>;
  blockTypeNames: Map<string, string>;
  defaultLocale: string | null;
  locales: ReadonlyArray<{ code: string; position: number; fallback_locale_id: string | null }>;
  resolvers: Record<string, Record<string, unknown>>;
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
