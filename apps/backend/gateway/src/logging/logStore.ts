/**
 * In-memory log store with search and retention
 * Issue #151
 */

import type { LogEntry, LogSearchQuery } from "@delegolabs/types";

const MAX_LOG_ENTRIES = 10000;
const DEFAULT_RETENTION_MS = 30 * 24 * 60 * 60 * 1000;

const logStore: LogEntry[] = [];
let retentionMs = DEFAULT_RETENTION_MS;

function pruneOldEntries(): void {
  const cutoff = Date.now() - retentionMs;
  while (logStore.length > 0) {
    const entry = logStore[0];
    if (Date.parse(entry.timestamp) < cutoff) {
      logStore.shift();
    } else {
      break;
    }
  }
  if (logStore.length > MAX_LOG_ENTRIES) {
    logStore.splice(0, logStore.length - MAX_LOG_ENTRIES);
  }
}

export function storeLogEntry(entry: LogEntry): void {
  pruneOldEntries();
  logStore.push(entry);
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
  return logStore.length;
}

export function setRetentionDays(days: number): void {
  retentionMs = days * 24 * 60 * 60 * 1000;
}

export function clearLogStore(): void {
  logStore.length = 0;
}
