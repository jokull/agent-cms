CREATE TABLE IF NOT EXISTS "assets" (
  "id" text PRIMARY KEY,
  "filename" text NOT NULL,
  "basename" text,
  "format" text,
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
  "custom_data" text DEFAULT '{}',
  "created_at" text NOT NULL,
  "updated_at" text NOT NULL,
  "created_by" text,
  "updated_by" text
);

CREATE TABLE IF NOT EXISTS "models" (
  "id" text PRIMARY KEY,
  "name" text NOT NULL,
  "api_key" text NOT NULL UNIQUE,
  "is_block" integer DEFAULT false NOT NULL,
  "singleton" integer DEFAULT false NOT NULL,
  "sortable" integer DEFAULT false NOT NULL,
  "tree" integer DEFAULT false NOT NULL,
  "has_draft" integer DEFAULT true NOT NULL,
  "all_locales_required" integer DEFAULT 0 NOT NULL,
  "ordering" text,
  "canonical_path_template" text,
  "created_at" text NOT NULL,
  "updated_at" text NOT NULL
);

CREATE TABLE IF NOT EXISTS "fieldsets" (
  "id" text PRIMARY KEY,
  "model_id" text NOT NULL,
  "title" text NOT NULL,
  "position" integer DEFAULT 0 NOT NULL,
  CONSTRAINT "fk_fieldsets_model_id_models_id_fk" FOREIGN KEY ("model_id") REFERENCES "models"("id") ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS "fields" (
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
);

CREATE TABLE IF NOT EXISTS "locales" (
  "id" text PRIMARY KEY,
  "code" text NOT NULL UNIQUE,
  "position" integer DEFAULT 0 NOT NULL,
  "fallback_locale_id" text,
  CONSTRAINT "fk_locales_fallback_locale_id_locales_id_fk" FOREIGN KEY ("fallback_locale_id") REFERENCES "locales"("id") ON DELETE SET NULL
);

CREATE TABLE IF NOT EXISTS "site_settings" (
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
);

CREATE TABLE IF NOT EXISTS "record_versions" (
  "id" text PRIMARY KEY,
  "model_api_key" text NOT NULL,
  "record_id" text NOT NULL,
  "version_number" integer NOT NULL,
  "snapshot" text NOT NULL,
  "action" text NOT NULL DEFAULT 'publish',
  "actor_type" text,
  "actor_label" text,
  "actor_token_id" text,
  "created_at" text NOT NULL
);

CREATE INDEX IF NOT EXISTS "idx_record_versions_lookup"
  ON "record_versions" ("model_api_key", "record_id", "version_number" DESC);

CREATE TABLE IF NOT EXISTS "editor_tokens" (
  "id" TEXT PRIMARY KEY,
  "name" TEXT NOT NULL,
  "token_prefix" TEXT NOT NULL,
  "secret_hash" TEXT NOT NULL,
  "created_at" TEXT NOT NULL DEFAULT (datetime('now')),
  "last_used_at" TEXT,
  "expires_at" TEXT
);

CREATE UNIQUE INDEX IF NOT EXISTS "idx_editor_tokens_secret_hash"
  ON "editor_tokens" ("secret_hash");

CREATE TABLE IF NOT EXISTS "preview_tokens" (
  "id" text PRIMARY KEY,
  "token_hash" text NOT NULL UNIQUE,
  "expires_at" text NOT NULL,
  "created_at" text NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS "idx_preview_tokens_hash"
  ON "preview_tokens" ("token_hash");
