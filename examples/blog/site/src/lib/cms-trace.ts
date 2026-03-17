export interface CmsQueryTrace {
  operationName: string | null;
  printMs: number;
  fetchMs: number;
  parseMs: number;
  totalMs: number;
  responseStatus: number;
  responseBytes: number;
  cmsRequestMs: number;
  cmsYogaMs: number;
  cmsSchemaWaitMs: number;
  cmsSchemaBuildMs: number;
  cmsSchemaCache: string | null;
  sqlStatementCount: number;
  sqlTotalMs: number;
  sqlSlowestSamplesMs: number[];
}

export interface CmsRequestTrace {
  traceId: string;
  enabled: boolean;
  queries: CmsQueryTrace[];
}

export function createCmsRequestTrace(request: Request): CmsRequestTrace {
  return {
    traceId: request.headers.get("x-trace-id") ?? crypto.randomUUID(),
    enabled: request.headers.get("x-bench-trace") === "1",
    queries: [],
  };
}

export function formatServerTiming(trace: CmsRequestTrace, totalMs: number): string {
  const totalFetchMs = trace.queries.reduce((sum, query) => sum + query.fetchMs, 0);
  const totalCmsMs = trace.queries.reduce((sum, query) => sum + query.cmsRequestMs, 0);
  const totalSchemaMs = trace.queries.reduce((sum, query) => sum + query.cmsSchemaWaitMs, 0);
  const totalSqlMs = trace.queries.reduce((sum, query) => sum + query.sqlTotalMs, 0);
  const maxFetchMs = trace.queries.reduce((max, query) => Math.max(max, query.fetchMs), 0);

  return [
    `app-total;dur=${totalMs.toFixed(3)}`,
    `app-cms-fetch-total;dur=${totalFetchMs.toFixed(3)}`,
    `app-cms-fetch-max;dur=${maxFetchMs.toFixed(3)}`,
    `app-cms-total;dur=${totalCmsMs.toFixed(3)}`,
    `app-cms-schema;dur=${totalSchemaMs.toFixed(3)}`,
    `app-cms-sql;dur=${totalSqlMs.toFixed(3)}`,
  ].join(", ");
}
