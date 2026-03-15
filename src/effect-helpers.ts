import { Effect } from "effect";
import type { Context as HonoContext } from "hono";
import { type CmsError, errorToResponse } from "./errors.js";

/**
 * Run an Effect program and return an HTTP response.
 * Success → 200 JSON (or custom status).
 * Typed CMS error → mapped to HTTP status code.
 * Unexpected error → 500.
 */
export function runEffect<A>(
  c: HonoContext,
  effect: Effect.Effect<A, CmsError>,
  successStatus: number = 200
): Response | Promise<Response> {
  return Effect.runPromise(
    effect.pipe(
      Effect.map((result) => c.json(result, successStatus as any)),
      Effect.catchAll((error) => {
        const { status, body } = errorToResponse(error);
        return Effect.succeed(c.json(body, status as any));
      })
    )
  );
}
