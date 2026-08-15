import { SqlClient, SqlError } from "effect/unstable/sql";
import { Effect } from "effect";
import type { D1Database } from "@cloudflare/workers-types";
import { recordSqlMetrics } from "../graphql/sql-metrics.js";
import { isObjectRecord } from "../value-utils.js";

export interface BatchedQuery {
  readonly sql: string;
  readonly params: ReadonlyArray<unknown>;
}

interface D1ClientLike {
  readonly config: {
    readonly db: D1Database;
  };
}

function isD1Database(value: unknown): value is D1Database {
  if (!isObjectRecord(value)) return false;
  return typeof value.prepare === "function"
    && typeof value.batch === "function";
}

function isD1ClientLike(value: unknown): value is SqlClient.SqlClient & D1ClientLike {
  if (!isObjectRecord(value)) return false;
  const { config } = value;
  if (!isObjectRecord(config)) return false;
  return isD1Database(config.db);
}

export function runBatchedQueries<T extends object>(
  queries: ReadonlyArray<BatchedQuery>,
  options?: {
    readonly phase?: string;
  },
): Effect.Effect<ReadonlyArray<ReadonlyArray<T>>, SqlError.SqlError, SqlClient.SqlClient> {
  return Effect.gen(function* () {
    if (queries.length === 0) {
      return [] satisfies ReadonlyArray<ReadonlyArray<T>>;
    }

    const startedAt = performance.now();
    const sql = yield* SqlClient.SqlClient;
    if (isD1ClientLike(sql)) {
      return yield* Effect.tryPromise({
        try: async () => {
          const statements = queries.map((query) =>
            sql.config.db.prepare(query.sql).bind(...query.params)
          );
          const results = await sql.config.db.batch<T>(statements);
          recordSqlMetrics(performance.now() - startedAt, {
            statementCount: queries.length,
            hopCount: 1,
            batchHopCount: 1,
            batchedStatementCount: queries.length,
            phase: options?.phase,
          });
          return results.map((result) => result.results);
        },
        catch: (cause) => new SqlError.SqlError({ reason: new SqlError.UnknownError({ cause, message: "Failed to execute D1 batch query" }) }),
      });
    }

    // Non-D1 fallback: no batch() API, so this runs N sequential round trips —
    // report the metrics that actually happened, not the D1-batch shape above.
    const results = yield* Effect.all(
      queries.map((query) => sql.unsafe<T>(query.sql, query.params)),
      { concurrency: 1 },
    );
    recordSqlMetrics(performance.now() - startedAt, {
      statementCount: queries.length,
      hopCount: queries.length,
      batchHopCount: 0,
      batchedStatementCount: 0,
      phase: options?.phase,
    });
    return results;
  });
}
