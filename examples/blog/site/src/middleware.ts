import type { MiddlewareHandler } from "astro";
import { createCmsRequestTrace, formatServerTiming } from "./lib/cms-trace";

export const onRequest: MiddlewareHandler = async (context, next) => {
  const startedAt = performance.now();
  const trace = createCmsRequestTrace(context.request);
  context.locals.cmsTrace = trace;

  // Draft preview: read token from cookie
  const previewToken = context.cookies.get("__agentcms_preview")?.value;
  if (previewToken) {
    context.locals.previewToken = previewToken;
  }

  const response = await next();
  const totalMs = performance.now() - startedAt;

  // Bypass caches when in preview mode
  if (previewToken) {
    response.headers.set("Cache-Control", "private, no-store");
  }

  if (!trace.enabled) {
    return response;
  }

  response.headers.set("X-Trace-Id", trace.traceId);
  response.headers.set("X-Site-Total-Ms", totalMs.toFixed(3));
  response.headers.set("X-Site-Cms-Query-Count", String(trace.queries.length));
  response.headers.set("X-Site-Cms-Fetch-Total-Ms", trace.queries.reduce((sum, query) => sum + query.fetchMs, 0).toFixed(3));
  response.headers.set("X-Site-Cms-Request-Total-Ms", trace.queries.reduce((sum, query) => sum + query.cmsRequestMs, 0).toFixed(3));
  response.headers.set("Server-Timing", formatServerTiming(trace, totalMs));

  console.info(JSON.stringify({
    scope: "site.request",
    traceId: trace.traceId,
    path: new URL(context.request.url).pathname,
    totalMs: Number(totalMs.toFixed(3)),
    cmsQueryCount: trace.queries.length,
    cmsFetchTotalMs: Number(trace.queries.reduce((sum, query) => sum + query.fetchMs, 0).toFixed(3)),
    cmsRequestTotalMs: Number(trace.queries.reduce((sum, query) => sum + query.cmsRequestMs, 0).toFixed(3)),
    queries: trace.queries,
  }));

  return response;
};
