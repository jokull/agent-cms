import { AsyncLocalStorage } from "node:async_hooks";

interface SqlMetricsStore {
  statementCount: number;
  hopCount: number;
  batchHopCount: number;
  batchedStatementCount: number;
  totalDurationMs: number;
  slowestSamplesMs: number[];
  byPhase: Map<string, {
    statementCount: number;
    hopCount: number;
    batchHopCount: number;
    batchedStatementCount: number;
    totalDurationMs: number;
  }>;
}

const sqlMetricsStorage = new AsyncLocalStorage<SqlMetricsStore>();

export function withSqlMetrics<T>(run: () => Promise<T>): Promise<T> {
  return sqlMetricsStorage.run({
    statementCount: 0,
    hopCount: 0,
    batchHopCount: 0,
    batchedStatementCount: 0,
    totalDurationMs: 0,
    slowestSamplesMs: [],
    byPhase: new Map(),
  }, run);
}

export function recordSqlMetrics(
  durationMs: number,
  options?: {
    readonly statementCount?: number;
    readonly hopCount?: number;
    readonly batchHopCount?: number;
    readonly batchedStatementCount?: number;
    readonly phase?: string;
  },
) {
  const store = sqlMetricsStorage.getStore();
  if (!store) return;
  const statementCount = options?.statementCount ?? 1;
  const hopCount = options?.hopCount ?? 1;
  const batchHopCount = options?.batchHopCount ?? 0;
  const batchedStatementCount = options?.batchedStatementCount ?? 0;
  store.statementCount += statementCount;
  store.hopCount += hopCount;
  store.batchHopCount += batchHopCount;
  store.batchedStatementCount += batchedStatementCount;
  store.totalDurationMs += durationMs;
  store.slowestSamplesMs.push(Number(durationMs.toFixed(3)));
  store.slowestSamplesMs.sort((a, b) => b - a);
  if (store.slowestSamplesMs.length > 5) {
    store.slowestSamplesMs.length = 5;
  }

  const phase = options?.phase;
  if (phase) {
    const current = store.byPhase.get(phase) ?? {
      statementCount: 0,
      hopCount: 0,
      batchHopCount: 0,
      batchedStatementCount: 0,
      totalDurationMs: 0,
    };
    current.statementCount += statementCount;
    current.hopCount += hopCount;
    current.batchHopCount += batchHopCount;
    current.batchedStatementCount += batchedStatementCount;
    current.totalDurationMs += durationMs;
    store.byPhase.set(phase, current);
  }
}

export function getSqlMetrics() {
  const store = sqlMetricsStorage.getStore();
  if (!store) return null;
  return {
    statementCount: store.statementCount,
    hopCount: store.hopCount,
    batchHopCount: store.batchHopCount,
    batchedStatementCount: store.batchedStatementCount,
    totalDurationMs: Number(store.totalDurationMs.toFixed(3)),
    slowestSamplesMs: store.slowestSamplesMs,
    byPhase: Object.fromEntries(
      [...store.byPhase.entries()]
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([phase, value]) => [phase, {
          statementCount: value.statementCount,
          hopCount: value.hopCount,
          batchHopCount: value.batchHopCount,
          batchedStatementCount: value.batchedStatementCount,
          totalDurationMs: Number(value.totalDurationMs.toFixed(3)),
        }]),
    ),
  };
}
