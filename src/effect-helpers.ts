import { Effect, Layer, ManagedRuntime } from "effect";
import type { Context as HonoContext } from "hono";
import { type CmsError, errorToResponse } from "./errors.js";
import { SqlClient } from "@effect/sql";

/**
 * Run an Effect program that requires SqlClient and return an HTTP response.
 * The SqlClient layer must be stored on the Hono context as "sqlLayer".
 */
export function runEffect<A>(
  c: HonoContext,
  effect: Effect.Effect<A, CmsError, SqlClient.SqlClient>,
  successStatus: number = 200
): Promise<Response> {
  const sqlLayer = c.get("sqlLayer") as Layer.Layer<SqlClient.SqlClient>;

  return Effect.runPromise(
    effect.pipe(
      Effect.map((result) => c.json(result, successStatus as any)),
      Effect.catchAll((error) => {
        const { status, body } = errorToResponse(error);
        return Effect.succeed(c.json(body, status as any));
      }),
      Effect.provide(sqlLayer)
    )
  );
}
