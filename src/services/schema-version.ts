/**
 * Shared schema-version counter.
 *
 * The generated GraphQL schema and the published fast-path / custom-query
 * metadata are all derived from the `models`, `fields`, and `locales` tables and
 * are cached *per Worker isolate*. Because runtime DDL (create/delete model or
 * field, locale changes, schema import) mutates that schema at request time, an
 * isolate that already built a schema would otherwise keep serving a stale one
 * forever — a mutation handled by isolate A never reaches isolate B.
 *
 * To bound cross-isolate staleness we keep a single monotonically increasing
 * integer in D1 (`_cms_meta.schema_version`) that every schema mutation bumps.
 * Each isolate's cache records the version it was built at and, at most once per
 * {@link SCHEMA_VERSION_TTL_MS}, does one cheap indexed read to check whether it
 * has fallen behind. This keeps the hot path free of D1 reads while guaranteeing
 * every isolate converges within ~TTL of any schema change.
 */
import { Effect, Layer } from "effect";
import { SqlClient } from "effect/unstable/sql";

/**
 * How long a built schema/metadata cache is trusted without re-checking the
 * shared version in D1. Bounds worst-case cross-isolate staleness to ~this long
 * while adding at most one tiny indexed read per isolate per interval.
 */
export const SCHEMA_VERSION_TTL_MS = 3000;

const SCHEMA_VERSION_KEY = "schema_version";

/**
 * Increment the shared schema-version counter. Must be called in the same code
 * path as every schema DDL / metadata mutation so no isolate can serve a stale
 * schema for longer than {@link SCHEMA_VERSION_TTL_MS}. Uses an UPSERT so the
 * row is created on first bump even if the seed migration has not run.
 */
export function bumpSchemaVersion() {
  return Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    yield* sql.unsafe(
      `INSERT INTO "_cms_meta" ("key", "value") VALUES (?, 1)
       ON CONFLICT("key") DO UPDATE SET "value" = "value" + 1`,
      [SCHEMA_VERSION_KEY],
    );
  });
}

/** Read the shared schema version. Returns 0 when unset. */
export function getSchemaVersion() {
  return Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const rows = yield* sql.unsafe<{ value: number }>(
      `SELECT "value" FROM "_cms_meta" WHERE "key" = ?`,
      [SCHEMA_VERSION_KEY],
    );
    return rows[0]?.value ?? 0;
  });
}

/**
 * Read the schema version as a Promise, defaulting to 0 on any error (e.g. the
 * `_cms_meta` table not existing yet). Never throws — a failed version read must
 * not take down a request.
 */
export function readSchemaVersionSafe(sqlLayer: Layer.Layer<SqlClient.SqlClient>): Promise<number> {
  return Effect.runPromise(
    getSchemaVersion().pipe(
      Effect.provide(sqlLayer),
      Effect.catch(() => Effect.succeed(0)),
    ),
  );
}

export interface VersionedCache<A, Ctx> {
  /** Return the cached value, rebuilding if stale beyond the TTL + version check. */
  get(ctx: Ctx): Promise<A>;
  /** Drop the cached value immediately (same-isolate invalidation). */
  invalidate(): void;
  /** Whether a value is currently cached (used for cold/warm telemetry). */
  isPrimed(): boolean;
}

/**
 * A per-isolate cache that self-invalidates against the shared D1 schema
 * version. Hot path (within TTL) never touches D1; after TTL it does one cheap
 * version read and only rebuilds when the version actually changed.
 */
export function createVersionedCache<A, Ctx = void>(
  sqlLayer: Layer.Layer<SqlClient.SqlClient>,
  load: (ctx: Ctx) => Promise<A>,
  onRebuilt?: () => void,
): VersionedCache<A, Ctx> {
  let cache: { version: number; value: A; builtAt: number } | null = null;
  let rebuild: Promise<A> | null = null;
  // Generation token: a rebuild only commits its result if it is still the
  // current one. An intervening invalidate() bumps this so a stale in-flight
  // build (e.g. started before a same-isolate mutation) never caches its value.
  let generation = 0;

  function doRebuild(ctx: Ctx): Promise<A> {
    if (rebuild) return rebuild;
    const myGeneration = generation;
    // Read the shared version BEFORE loading so the stored version can never be
    // ahead of what the loaded value reflects. If a mutation lands during the
    // load, the stored version stays behind and the next check rebuilds again.
    const promise = (async () => {
      try {
        const version = await readSchemaVersionSafe(sqlLayer);
        const value = await load(ctx);
        if (generation === myGeneration) {
          cache = { version, value, builtAt: Date.now() };
          onRebuilt?.();
        }
        return value;
      } finally {
        if (generation === myGeneration) rebuild = null;
      }
    })();
    rebuild = promise;
    return promise;
  }

  return {
    async get(ctx: Ctx): Promise<A> {
      const cached = cache;
      if (cached && Date.now() - cached.builtAt < SCHEMA_VERSION_TTL_MS) {
        return cached.value;
      }
      if (cached) {
        const version = await readSchemaVersionSafe(sqlLayer);
        if (version === cached.version) {
          cached.builtAt = Date.now();
          return cached.value;
        }
      }
      return doRebuild(ctx);
    },
    invalidate() {
      cache = null;
      rebuild = null;
      generation += 1;
    },
    isPrimed() {
      return cache !== null;
    },
  };
}
