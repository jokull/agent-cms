import { SqlClient, SqlError } from "@effect/sql";
import { Effect } from "effect";
import type { D1Database } from "@cloudflare/workers-types";
import { recordSqlMetrics } from "../graphql/sql-metrics.js";

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
  if (typeof value !== "object" || value === null) return false;
  return typeof Reflect.get(value, "prepare") === "function"
    && typeof Reflect.get(value, "batch") === "function";
}

function isD1ClientLike(value: unknown): value is SqlClient.SqlClient & D1ClientLike {
  if (typeof value !== "object" || value === null) return false;
  const config = Reflect.get(value, "config");
  if (typeof config !== "object" || config === null) return false;
  return isD1Database(Reflect.get(config, "db"));
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
        catch: (cause) => new SqlError.SqlError({ cause, message: "Failed to execute D1 batch query" }),
      });
    }

    const results = yield* Effect.all(
      queries.map((query) => sql.unsafe<T>(query.sql, query.params)),
      { concurrency: 1 },
    );
    recordSqlMetrics(performance.now() - startedAt, {
      statementCount: queries.length,
      hopCount: 1,
      batchHopCount: 1,
      batchedStatementCount: queries.length,
      phase: options?.phase,
    });
    return results;
  });
}
