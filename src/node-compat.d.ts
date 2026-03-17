// Type declarations for Node.js built-in modules used via Cloudflare's nodejs_compat flag.
// These are available at runtime in Workers but not included in @cloudflare/workers-types.
declare module "node:async_hooks" {
  export class AsyncLocalStorage<T> {
    run<R>(store: T, callback: () => R): R;
    getStore(): T | undefined;
  }
}
