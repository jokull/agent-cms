/**
 * Embedded schema migrations — runs automatically on first request.
 * Each migration is idempotent (CREATE TABLE IF NOT EXISTS / ADD COLUMN IF NOT EXISTS).
 */
import { Effect } from "effect";
import { SqlClient } from "@effect/sql";

interface Migration {
  readonly version: number;
  readonly statements: readonly string[];
}

const MIGRATIONS: readonly Migration[] = [
  {
    version: 1,
    statements: [
      `CREATE TABLE IF NOT EXISTS "assets" (
        "id" text PRIMARY KEY,
        "filename" text NOT NULL,
        "mime_type" text NOT NULL,
        "size" integer NOT NULL,
        "width" integer,
        "height" integer,
        "alt" text,
        "title" text,
        "r2_key" text NOT NULL,
        "blurhash" text,
        "colors" text,
        "focal_point" text,
        "tags" text DEFAULT '[]',
        "created_at" text NOT NULL
      )`,
      `CREATE TABLE IF NOT EXISTS "models" (
        "id" text PRIMARY KEY,
        "name" text NOT NULL,
        "api_key" text NOT NULL UNIQUE,
        "is_block" integer DEFAULT false NOT NULL,
        "singleton" integer DEFAULT false NOT NULL,
        "sortable" integer DEFAULT false NOT NULL,
        "tree" integer DEFAULT false NOT NULL,
        "has_draft" integer DEFAULT true NOT NULL,
        "ordering" text,
        "created_at" text NOT NULL,
        "updated_at" text NOT NULL
      )`,
      `CREATE TABLE IF NOT EXISTS "fieldsets" (
        "id" text PRIMARY KEY,
        "model_id" text NOT NULL,
        "title" text NOT NULL,
        "position" integer DEFAULT 0 NOT NULL,
        CONSTRAINT "fk_fieldsets_model_id_models_id_fk" FOREIGN KEY ("model_id") REFERENCES "models"("id") ON DELETE CASCADE
      )`,
      `CREATE TABLE IF NOT EXISTS "fields" (
        "id" text PRIMARY KEY,
        "model_id" text NOT NULL,
        "label" text NOT NULL,
        "api_key" text NOT NULL,
        "field_type" text NOT NULL,
        "position" integer DEFAULT 0 NOT NULL,
        "localized" integer DEFAULT false NOT NULL,
        "validators" text DEFAULT '{}',
        "default_value" text,
        "appearance" text,
        "hint" text,
        "fieldset_id" text,
        "created_at" text NOT NULL,
        "updated_at" text NOT NULL,
        CONSTRAINT "fk_fields_model_id_models_id_fk" FOREIGN KEY ("model_id") REFERENCES "models"("id") ON DELETE CASCADE,
        CONSTRAINT "fk_fields_fieldset_id_fieldsets_id_fk" FOREIGN KEY ("fieldset_id") REFERENCES "fieldsets"("id") ON DELETE SET NULL
      )`,
      `CREATE TABLE IF NOT EXISTS "locales" (
        "id" text PRIMARY KEY,
        "code" text NOT NULL UNIQUE,
        "position" integer DEFAULT 0 NOT NULL,
        "fallback_locale_id" text,
        CONSTRAINT "fk_locales_fallback_locale_id_locales_id_fk" FOREIGN KEY ("fallback_locale_id") REFERENCES "locales"("id") ON DELETE SET NULL
      )`,
    ],
  },
  {
    version: 2,
    statements: [
      `CREATE TABLE IF NOT EXISTS "site_settings" (
        "id" text PRIMARY KEY DEFAULT 'default',
        "site_name" text,
        "title_suffix" text,
        "no_index" integer DEFAULT 0 NOT NULL,
        "favicon_id" text,
        "facebook_page_url" text,
        "twitter_account" text,
        "fallback_seo_title" text,
        "fallback_seo_description" text,
        "fallback_seo_image_id" text,
        "fallback_seo_twitter_card" text DEFAULT 'summary',
        "updated_at" text NOT NULL DEFAULT (datetime('now')),
        CONSTRAINT "fk_site_settings_favicon" FOREIGN KEY ("favicon_id") REFERENCES "assets"("id") ON DELETE SET NULL,
        CONSTRAINT "fk_site_settings_seo_image" FOREIGN KEY ("fallback_seo_image_id") REFERENCES "assets"("id") ON DELETE SET NULL
      )`,
      // ADD COLUMN is not idempotent in SQLite — check first
      `ALTER TABLE "assets" ADD COLUMN "custom_data" text DEFAULT '{}'`,
    ],
  },
];

/**
 * Ensure all CMS system tables exist.
 * Uses a _cms_migrations tracking table. Idempotent — safe to call on every request.
 * Fast path: single SELECT after first run.
 */
export function ensureSchema() {
  return Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;

    // Create tracking table
    yield* sql.unsafe(
      `CREATE TABLE IF NOT EXISTS "_cms_migrations" ("version" integer PRIMARY KEY, "applied_at" text NOT NULL DEFAULT (datetime('now')))`
    );

    // Check which migrations have been applied
    const applied = yield* sql.unsafe<{ version: number }>(
      "SELECT version FROM _cms_migrations"
    );
    const appliedSet = new Set(applied.map((r) => r.version));

    // Run pending migrations
    for (const migration of MIGRATIONS) {
      if (appliedSet.has(migration.version)) continue;
      for (const stmt of migration.statements) {
        yield* sql.unsafe(stmt).pipe(
          // ALTER TABLE ADD COLUMN fails if column already exists — that's OK
          Effect.catchAll(() => Effect.void)
        );
      }
      yield* sql.unsafe(
        "INSERT INTO _cms_migrations (version) VALUES (?)",
        [migration.version]
      );
    }
  });
}
