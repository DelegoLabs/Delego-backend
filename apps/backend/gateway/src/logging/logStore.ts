/**
 * In-memory log store with search, bounded capacity and retention pruning
 * Issue #151, #814
 */

import type { LogEntry, LogSearchQuery } from "@delegolabs/types";

const DAY_MS = 24 * 60 * 60 * 1000;

export interface LogStoreConfig {
  maxEntries: number;
  retentionMs: number;
  pruneIntervalMs: number;
}

const DEFAULT_CONFIG: LogStoreConfig = {
  maxEntries: 10000,
  retentionMs: 30 * DAY_MS,
  pruneIntervalMs: 60 * 60 * 1000,
};

const logStore: LogEntry[] = [];
let config: LogStoreConfig = { ...DEFAULT_CONFIG };
let pruneTimer: ReturnType<typeof setInterval> | null = null;

function positiveNumber(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : fallback;
}

function pruneOldEntries(): void {
  const cutoff = Date.now() - config.retentionMs;

  // Full sweep rather than prefix shift: a backdated entry can be inserted
  // after a fresh one and still needs to expire on time.
  for (let i = logStore.length - 1; i >= 0; i--) {
    if (Date.parse(logStore[i].timestamp) < cutoff) {
      logStore.splice(i, 1);
    }
  }

  // Keep the newest entries by insertion order (ring-buffer semantics).
  if (logStore.length > config.maxEntries) {
    logStore.splice(0, logStore.length - config.maxEntries);
  }
}

export function configureLogStore(options: Partial<LogStoreConfig> = {}): void {
  config = {
    maxEntries: Math.floor(positiveNumber(options.maxEntries, config.maxEntries)),
    retentionMs: positiveNumber(options.retentionMs, config.retentionMs),
    pruneIntervalMs: positiveNumber(options.pruneIntervalMs, config.pruneIntervalMs),
  };
  pruneOldEntries();

  if (pruneTimer && options.pruneIntervalMs !== undefined) {
    stopLogPruning();
    startLogPruning(config.pruneIntervalMs);
  }
}

export function getLogStoreConfig(): LogStoreConfig {
  return { ...config };
}

export function storeLogEntry(entry: LogEntry): void {
  logStore.push(entry);
  // Prune after insertion so the store is immediately bounded and an expired
  // timestamp cannot linger until the next read.
  pruneOldEntries();
}

export function searchLogs(query: LogSearchQuery): LogEntry[] {
  pruneOldEntries();

  let results = [...logStore];

  if (query.userId) {
    results = results.filter((e) => e.userId === query.userId);
  }
  if (query.path) {
    results = results.filter((e) => e.path.includes(query.path!));
  }
  if (query.method) {
    results = results.filter((e) => e.method === query.method);
  }
  if (query.statusCode !== undefined) {
    results = results.filter((e) => e.responseStatus === query.statusCode);
  }

  const startMs = Date.parse(query.startTime);
  const endMs = Date.parse(query.endTime);
  if (!isNaN(startMs)) {
    results = results.filter((e) => Date.parse(e.timestamp) >= startMs);
  }
  if (!isNaN(endMs)) {
    results = results.filter((e) => Date.parse(e.timestamp) <= endMs);
  }

  if (!query.includeMasked) {
    results = results.filter((e) => e.piiMasked);
  }

  return results.slice(-query.limit);
}

export function getLogEntryCount(): number {
  pruneOldEntries();
  return logStore.length;
}

export function setRetentionDays(days: number): void {
  configureLogStore({ retentionMs: positiveNumber(days, 30) * DAY_MS });
}

export function startLogPruning(intervalMs: number = config.pruneIntervalMs): void {
  if (pruneTimer) return;
  config.pruneIntervalMs = positiveNumber(intervalMs, DEFAULT_CONFIG.pruneIntervalMs);
  pruneTimer = setInterval(pruneOldEntries, config.pruneIntervalMs);
  // Do not keep a worker process alive solely for the cleanup timer.
  pruneTimer.unref?.();
}

export function stopLogPruning(): void {
  if (pruneTimer) {
    clearInterval(pruneTimer);
    pruneTimer = null;
  }
}

export function clearLogStore(): void {
  logStore.length = 0;
}
