import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { LogEntry, LogSearchQuery } from "@delegolabs/types";
import {
  clearLogStore,
  configureLogStore,
  getLogEntryCount,
  getLogStoreConfig,
  searchLogs,
  setRetentionDays,
  startLogPruning,
  stopLogPruning,
  storeLogEntry,
} from "./logStore.js";

function entry(requestId: string, timestampMs = Date.now(), overrides: Partial<LogEntry> = {}): LogEntry {
  return {
    requestId,
    timestamp: new Date(timestampMs).toISOString(),
    method: "GET",
    path: "/api/v1/escrows",
    requestHeaders: {},
    requestBody: {},
    responseStatus: 200,
    responseHeaders: {},
    responseBody: {},
    durationMs: 12,
    piiMasked: true,
    ...overrides,
  };
}

function query(overrides: Partial<LogSearchQuery> = {}): LogSearchQuery {
  return {
    startTime: new Date(0).toISOString(),
    endTime: new Date(Date.now() + 60_000).toISOString(),
    limit: 100,
    includeMasked: true,
    ...overrides,
  };
}

describe("logStore (#814)", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-11-24T12:00:00Z"));
    stopLogPruning();
    clearLogStore();
    configureLogStore({ maxEntries: 3, retentionMs: 60_000, pruneIntervalMs: 10_000 });
  });

  afterEach(() => {
    stopLogPruning();
    clearLogStore();
    vi.useRealTimers();
  });

  it("expires entries by timestamp even when a newer entry was stored first", () => {
    const now = Date.now();
    storeLogEntry(entry("fresh", now));
    storeLogEntry(entry("backdated", now - 120_000));

    expect(getLogEntryCount()).toBe(1);
    expect(searchLogs(query()).map((item) => item.requestId)).toEqual(["fresh"]);
  });

  it("evicts the oldest entries once the configured capacity is reached", () => {
    const now = Date.now();
    for (let i = 1; i <= 5; i++) storeLogEntry(entry(`req-${i}`, now + i));

    expect(getLogEntryCount()).toBe(3);
    expect(searchLogs(query()).map((item) => item.requestId)).toEqual(["req-3", "req-4", "req-5"]);
  });

  it("applies search filters for user, path, method, status and time range", () => {
    configureLogStore({ maxEntries: 10 });
    const now = Date.now();
    storeLogEntry(entry("match", now, { userId: "alice", path: "/api/v1/escrows/a", method: "GET", responseStatus: 200 }));
    storeLogEntry(entry("other-user", now, { userId: "bob" }));
    storeLogEntry(entry("other-status", now, { responseStatus: 500 }));
    storeLogEntry(entry("old-window", now - 30_000));

    expect(
      searchLogs(
        query({
          userId: "alice",
          path: "/escrows/a",
          method: "GET",
          statusCode: 200,
          startTime: new Date(now - 1_000).toISOString(),
          endTime: new Date(now + 1_000).toISOString(),
        }),
      ).map((item) => item.requestId),
    ).toEqual(["match"]);
  });

  it("excludes unmasked entries unless explicitly requested", () => {
    const now = Date.now();
    storeLogEntry(entry("masked", now, { piiMasked: true }));
    storeLogEntry(entry("unmasked", now, { piiMasked: false }));

    expect(searchLogs(query({ includeMasked: false })).map((item) => item.requestId)).toEqual(["masked"]);
  });

  it("prunes periodically while the cleanup timer is running", () => {
    storeLogEntry(entry("expiring", Date.now()));

    expect(vi.getTimerCount()).toBe(0);
    startLogPruning();
    expect(vi.getTimerCount()).toBe(1);

    vi.advanceTimersByTime(70_000);
    expect(getLogEntryCount()).toBe(0);

    stopLogPruning();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("updates retention through the public configuration helpers", () => {
    setRetentionDays(2);
    expect(getLogStoreConfig().retentionMs).toBe(2 * 24 * 60 * 60 * 1000);

    configureLogStore({ maxEntries: 7, pruneIntervalMs: 5_000 });
    expect(getLogStoreConfig()).toEqual({
      maxEntries: 7,
      retentionMs: 2 * 24 * 60 * 60 * 1000,
      pruneIntervalMs: 5_000,
    });
  });

  it("ignores invalid configuration values instead of creating an unbounded store", () => {
    configureLogStore({ maxEntries: 0, retentionMs: -1, pruneIntervalMs: NaN });

    expect(getLogStoreConfig()).toEqual({
      maxEntries: 3,
      retentionMs: 60_000,
      pruneIntervalMs: 10_000,
    });
  });
});
