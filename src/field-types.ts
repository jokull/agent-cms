/**
 * Typed field type registry.
 *
 * Each field type defines its static properties in one place:
 * SQL storage, GraphQL type, filter type, validation schema, etc.
 *
 * The "type sandwich":
 * - Top: system tables (models, fields) are statically typed
 * - Middle: which fields exist on which models is dynamic (runtime)
 * - Bottom: each field type's shape is statically known (this file)
 */
import { Schema } from "effect";
import type { FieldType } from "./types.js";

/** Effect Schemas for composite field type validation */
export const ColorSchema = Schema.Struct({
  red: Schema.Number.pipe(Schema.int(), Schema.between(0, 255)),
  green: Schema.Number.pipe(Schema.int(), Schema.between(0, 255)),
  blue: Schema.Number.pipe(Schema.int(), Schema.between(0, 255)),
  alpha: Schema.optional(Schema.Number.pipe(Schema.int(), Schema.between(0, 255))),
});

export const LatLonSchema = Schema.Struct({
  latitude: Schema.Number.pipe(Schema.between(-90, 90)),
  longitude: Schema.Number.pipe(Schema.between(-180, 180)),
});

export const SeoSchema = Schema.Struct({
  title: Schema.optional(Schema.String),
  description: Schema.optional(Schema.String),
  image: Schema.optional(Schema.String),
  twitterCard: Schema.optional(Schema.String),
});

/** Static definition for a field type — everything known at compile time */
export interface FieldTypeDefinition {
  /** SQLite column type */
  readonly sqliteType: "TEXT" | "INTEGER" | "REAL";

  /** GraphQL SDL type name. Null means it depends on validators (link/links). */
  readonly graphqlType: string | null;

  /** GraphQL filter input type name, or null if not filterable */
  readonly filterType: string | null;

  /** Whether this field supports locale-based value resolution */
  readonly localizable: boolean;

  /** GraphQL multi-locale type for _all<Field>Locales */
  readonly multiLocaleType: string;

  /** Effect Schema for write-time validation, or null if no validation needed */
  readonly inputSchema: Schema.Schema<any, any, never> | null;

  /** Whether the stored value is JSON that needs parsing */
  readonly jsonStored: boolean;

  /**
   * Whether this field type has a custom GraphQL resolver.
   * If true, schema-builder registers a resolver (link resolution, asset lookup, etc.)
   * If false, the raw DB value is returned as-is.
   */
  readonly hasCustomResolver: boolean;
}

/**
 * The field type registry — one entry per field type.
 * Add a new field type here and TypeScript will enforce all properties are defined.
 */
export const FIELD_TYPE_REGISTRY: Record<FieldType, FieldTypeDefinition> = {
  string: {
    sqliteType: "TEXT",
    graphqlType: "String",
    filterType: "StringFilter",
    localizable: true,
    multiLocaleType: "StringMultiLocaleField",
    inputSchema: null,
    jsonStored: false,
    hasCustomResolver: false,
  },
  text: {
    sqliteType: "TEXT",
    graphqlType: "String",
    filterType: "StringFilter",
    localizable: true,
    multiLocaleType: "StringMultiLocaleField",
    inputSchema: null,
    jsonStored: false,
    hasCustomResolver: false,
  },
  boolean: {
    sqliteType: "INTEGER",
    graphqlType: "Boolean",
    filterType: "BooleanFilter",
    localizable: true,
    multiLocaleType: "BooleanMultiLocaleField",
    inputSchema: null,
    jsonStored: false,
    hasCustomResolver: false,
  },
  integer: {
    sqliteType: "INTEGER",
    graphqlType: "Int",
    filterType: "IntFilter",
    localizable: true,
    multiLocaleType: "IntMultiLocaleField",
    inputSchema: null,
    jsonStored: false,
    hasCustomResolver: false,
  },
  float: {
    sqliteType: "REAL",
    graphqlType: "Float",
    filterType: "FloatFilter",
    localizable: true,
    multiLocaleType: "FloatMultiLocaleField",
    inputSchema: null,
    jsonStored: false,
    hasCustomResolver: false,
  },
  slug: {
    sqliteType: "TEXT",
    graphqlType: "String",
    filterType: "StringFilter",
    localizable: true,
    multiLocaleType: "StringMultiLocaleField",
    inputSchema: null,
    jsonStored: false,
    hasCustomResolver: false,
  },
  date: {
    sqliteType: "TEXT",
    graphqlType: "String",
    filterType: "StringFilter",
    localizable: true,
    multiLocaleType: "StringMultiLocaleField",
    inputSchema: null,
    jsonStored: false,
    hasCustomResolver: false,
  },
  date_time: {
    sqliteType: "TEXT",
    graphqlType: "String",
    filterType: "StringFilter",
    localizable: true,
    multiLocaleType: "StringMultiLocaleField",
    inputSchema: null,
    jsonStored: false,
    hasCustomResolver: false,
  },
  media: {
    sqliteType: "TEXT",
    graphqlType: "Asset",
    filterType: "LinkFilter",
    localizable: false,
    multiLocaleType: "StringMultiLocaleField",
    inputSchema: null,
    jsonStored: false,
    hasCustomResolver: true,
  },
  media_gallery: {
    sqliteType: "TEXT",
    graphqlType: "[Asset!]",
    filterType: "LinksFilter",
    localizable: false,
    multiLocaleType: "StringMultiLocaleField",
    inputSchema: null,
    jsonStored: true,
    hasCustomResolver: true,
  },
  link: {
    sqliteType: "TEXT",
    graphqlType: null, // depends on validators (target model)
    filterType: "LinkFilter",
    localizable: false,
    multiLocaleType: "StringMultiLocaleField",
    inputSchema: null,
    jsonStored: false,
    hasCustomResolver: true,
  },
  links: {
    sqliteType: "TEXT",
    graphqlType: null, // depends on validators (target models)
    filterType: "LinksFilter",
    localizable: false,
    multiLocaleType: "StringMultiLocaleField",
    inputSchema: null,
    jsonStored: true,
    hasCustomResolver: true,
  },
  structured_text: {
    sqliteType: "TEXT",
    graphqlType: "StructuredText",
    filterType: "TextFilter",
    localizable: false,
    multiLocaleType: "StringMultiLocaleField",
    inputSchema: null,
    jsonStored: true,
    hasCustomResolver: true,
  },
  seo: {
    sqliteType: "TEXT",
    graphqlType: "SeoField",
    filterType: "ExistsFilter",
    localizable: false,
    multiLocaleType: "StringMultiLocaleField",
    inputSchema: SeoSchema,
    jsonStored: true,
    hasCustomResolver: true,
  },
  json: {
    sqliteType: "TEXT",
    graphqlType: "JSON",
    filterType: "ExistsFilter",
    localizable: false,
    multiLocaleType: "StringMultiLocaleField",
    inputSchema: null,
    jsonStored: true,
    hasCustomResolver: false,
  },
  color: {
    sqliteType: "TEXT",
    graphqlType: "ColorField",
    filterType: "ExistsFilter",
    localizable: false,
    multiLocaleType: "StringMultiLocaleField",
    inputSchema: ColorSchema,
    jsonStored: true,
    hasCustomResolver: true,
  },
  lat_lon: {
    sqliteType: "TEXT",
    graphqlType: "LatLonField",
    filterType: "LatLonFilter",
    localizable: false,
    multiLocaleType: "StringMultiLocaleField",
    inputSchema: LatLonSchema,
    jsonStored: true,
    hasCustomResolver: true,
  },
};

/** Get the registry definition for a field type */
export function getFieldTypeDef(fieldType: FieldType): FieldTypeDefinition {
  return FIELD_TYPE_REGISTRY[fieldType];
}
