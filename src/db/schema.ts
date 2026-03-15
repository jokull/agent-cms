import { sqliteTable, text, integer } from "drizzle-orm/sqlite-core";

// --- System Tables ---
// These are static Drizzle tables that define the CMS meta-schema.
// The schema engine reads these to generate dynamic content/block tables.

export const models = sqliteTable("models", {
  id: text("id").primaryKey(), // ULID
  name: text("name").notNull(),
  apiKey: text("api_key").notNull().unique(),
  isBlock: integer("is_block", { mode: "boolean" }).notNull().default(false),
  singleton: integer("singleton", { mode: "boolean" }).notNull().default(false),
  sortable: integer("sortable", { mode: "boolean" }).notNull().default(false),
  tree: integer("tree", { mode: "boolean" }).notNull().default(false),
  hasDraft: integer("has_draft", { mode: "boolean" }).notNull().default(true),
  ordering: text("ordering"), // default ordering field api_key
  createdAt: text("created_at").notNull(),
  updatedAt: text("updated_at").notNull(),
});

export const fields = sqliteTable("fields", {
  id: text("id").primaryKey(), // ULID
  modelId: text("model_id")
    .notNull()
    .references(() => models.id, { onDelete: "cascade" }),
  label: text("label").notNull(),
  apiKey: text("api_key").notNull(),
  fieldType: text("field_type").notNull(), // string, text, boolean, integer, slug, media, media_gallery, link, links, structured_text
  position: integer("position").notNull().default(0),
  localized: integer("localized", { mode: "boolean" }).notNull().default(false),
  validators: text("validators", { mode: "json" }).$type<Record<string, unknown>>().default({}),
  defaultValue: text("default_value", { mode: "json" }),
  appearance: text("appearance", { mode: "json" }),
  hint: text("hint"),
  fieldsetId: text("fieldset_id").references(() => fieldsets.id, {
    onDelete: "set null",
  }),
  createdAt: text("created_at").notNull(),
  updatedAt: text("updated_at").notNull(),
});

export const fieldsets = sqliteTable("fieldsets", {
  id: text("id").primaryKey(), // ULID
  modelId: text("model_id")
    .notNull()
    .references(() => models.id, { onDelete: "cascade" }),
  title: text("title").notNull(),
  position: integer("position").notNull().default(0),
});

export const locales = sqliteTable("locales", {
  id: text("id").primaryKey(), // ULID
  code: text("code").notNull().unique(), // e.g. "en", "is"
  position: integer("position").notNull().default(0),
  fallbackLocaleId: text("fallback_locale_id").references((): any => locales.id, {
    onDelete: "set null",
  }),
});

export const assets = sqliteTable("assets", {
  id: text("id").primaryKey(), // ULID
  filename: text("filename").notNull(),
  mimeType: text("mime_type").notNull(),
  size: integer("size").notNull(), // bytes
  width: integer("width"),
  height: integer("height"),
  alt: text("alt"),
  title: text("title"),
  r2Key: text("r2_key").notNull(),
  blurhash: text("blurhash"),
  colors: text("colors", { mode: "json" }).$type<string[]>(),
  focalPoint: text("focal_point", { mode: "json" }).$type<{ x: number; y: number }>(),
  tags: text("tags", { mode: "json" }).$type<string[]>().default([]),
  createdAt: text("created_at").notNull(),
});
