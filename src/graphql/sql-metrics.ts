import { AsyncLocalStorage } from "node:async_hooks";

interface SqlMetricsStore {
  statementCount: number;
  totalDurationMs: number;
  slowestSamplesMs: number[];
}

const sqlMetricsStorage = new AsyncLocalStorage<SqlMetricsStore>();

export function withSqlMetrics<T>(run: () => Promise<T>): Promise<T> {
  return sqlMetricsStorage.run({ statementCount: 0, totalDurationMs: 0, slowestSamplesMs: [] }, run);
}

export function recordSqlMetrics(durationMs: number) {
  const store = sqlMetricsStorage.getStore();
  if (!store) return;
  store.statementCount += 1;
  store.totalDurationMs += durationMs;
  store.slowestSamplesMs.push(Number(durationMs.toFixed(3)));
  store.slowestSamplesMs.sort((a, b) => b - a);
  if (store.slowestSamplesMs.length > 5) {
    store.slowestSamplesMs.length = 5;
  }
}

export function getSqlMetrics() {
  const store = sqlMetricsStorage.getStore();
  if (!store) return null;
  return {
    statementCount: store.statementCount,
    totalDurationMs: Number(store.totalDurationMs.toFixed(3)),
    slowestSamplesMs: store.slowestSamplesMs,
  };
}
