/**
 * Lifecycle hooks for content events.
 * Passed to createCMSHandler, fired in the service layer.
 */
import { Context, Data, Effect, Option } from "effect";

export interface CmsHooks {
  readonly onRecordCreate?: (event: { modelApiKey: string; recordId: string }) => void | Promise<void>;
  readonly onRecordUpdate?: (event: { modelApiKey: string; recordId: string }) => void | Promise<void>;
  readonly onRecordDelete?: (event: { modelApiKey: string; recordId: string }) => void | Promise<void>;
  readonly onPublish?: (event: { modelApiKey: string; recordId: string }) => void | Promise<void>;
  readonly onUnpublish?: (event: { modelApiKey: string; recordId: string }) => void | Promise<void>;
}

export class HooksContext extends Context.Tag("HooksContext")<
  HooksContext,
  Option.Option<CmsHooks>
>() {}

class HookExecutionError extends Data.TaggedError("HookExecutionError")<{
  cause: unknown;
}> {}

/**
 * Fire a lifecycle hook if configured. Non-blocking — errors are logged, not propagated.
 */
export function fireHook(
  hookName: keyof CmsHooks,
  event: { modelApiKey: string; recordId: string }
) {
  return Effect.gen(function* () {
    const hooks = yield* HooksContext;
    if (Option.isNone(hooks)) return;
    const fn = hooks.value[hookName];
    if (!fn) return;
    yield* Effect.tryPromise({
      try: () => Promise.resolve(fn(event)),
      catch: (cause) => new HookExecutionError({ cause }),
    }).pipe(Effect.ignore);
  });
}
