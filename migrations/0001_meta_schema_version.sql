-- Shared metadata KV. `schema_version` is bumped on every schema mutation
-- (create/update/delete model or field, locale changes, schema import) so that
-- Worker isolates can detect when their per-isolate cached GraphQL schema /
-- fast-path metadata has gone stale and rebuild it.
CREATE TABLE IF NOT EXISTS "_cms_meta" (
  "key" text PRIMARY KEY,
  "value" integer NOT NULL DEFAULT 0
);

INSERT OR IGNORE INTO "_cms_meta" ("key", "value") VALUES ('schema_version', 0);
