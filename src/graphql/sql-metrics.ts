import { AsyncLocalStorage } from "node:async_hooks";

interface SqlMetricsStore {
  statementCount: number;
  totalDurationMs: number;
}

const sqlMetricsStorage = new AsyncLocalStorage<SqlMetricsStore>();

export function withSqlMetrics<T>(run: () => Promise<T>): Promise<T> {
  return sqlMetricsStorage.run({ statementCount: 0, totalDurationMs: 0 }, run);
}

export function recordSqlMetrics(durationMs: number) {
  const store = sqlMetricsStorage.getStore();
  if (!store) return;
  store.statementCount += 1;
  store.totalDurationMs += durationMs;
}

export function getSqlMetrics() {
  const store = sqlMetricsStorage.getStore();
  if (!store) return null;
  return {
    statementCount: store.statementCount,
    totalDurationMs: Number(store.totalDurationMs.toFixed(3)),
  };
}
