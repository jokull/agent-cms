CREATE TABLE IF NOT EXISTS "record_versions" (
  "id" text PRIMARY KEY,
  "model_api_key" text NOT NULL,
  "record_id" text NOT NULL,
  "version_number" integer NOT NULL,
  "snapshot" text NOT NULL,
  "created_at" text NOT NULL
);

CREATE INDEX IF NOT EXISTS "idx_record_versions_lookup"
  ON "record_versions" ("model_api_key", "record_id", "version_number" DESC);
