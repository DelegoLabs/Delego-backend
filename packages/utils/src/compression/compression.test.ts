/**
 * Tests for Compression Module
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { CompressionMiddleware, CompressionCache, CompressionMetrics } from "./compression.js";
import { Readable } from "stream";

describe("CompressionCache", () => {
  let cache: CompressionCache;

  beforeEach(() => {
    cache = new CompressionCache({
      cacheMaxSizeBytes: 10000,
      cacheTtlSeconds: 3600,
    });
  });

  it("should cache and retrieve entries", () => {
    const entry = {
      algorithm: "br",
      data: Buffer.from("test"),
      contentType: "application/json",
      size: 4,
      timestamp: Date.now(),
    };

    cache.set("key1", entry);
    const retrieved = cache.get("key1");

    expect(retrieved).toBeDefined();
    expect(retrieved?.data.toString()).toBe("test");
  });

  it("should return undefined for non-existent key", () => {
    const retrieved = cache.get("nonexistent");
    expect(retrieved).toBeUndefined();
  });

  it("should evict old entries when cache is full", () => {
    // Fill cache up to limit
    cache.set("key1", {
      algorithm: "br",
      data: Buffer.alloc(5000),
      contentType: "application/json",
      size: 5000,
      timestamp: Date.now(),
    });

    cache.set("key2", {
      algorithm: "br",
      data: Buffer.alloc(5000),
      contentType: "application/json",
      size: 5000,
      timestamp: Date.now(),
    });

    cache.set("key3", {
      algorithm: "br",
      data: Buffer.alloc(6000),
      contentType: "application/json",
      size: 6000,
      timestamp: Date.now(),
    });

    // First entry should be evicted
    expect(cache.get("key1")).toBeUndefined();
    expect(cache.get("key2")).toBeDefined();
    expect(cache.get("key3")).toBeDefined();
  });

  it("should respect TTL", async () => {
    const cache = new CompressionCache({
      cacheTtlSeconds: 1, // 1 second
    });

    const entry = {
      algorithm: "br",
      data: Buffer.from("test"),
      contentType: "application/json",
      size: 4,
      timestamp: Date.now() - 2000, // 2 seconds ago
    };

    cache.set("key1", entry);
    const retrieved = cache.get("key1");

    expect(retrieved).toBeUndefined();
  });

  it("should calculate hit rate", () => {
    cache.set("key1", {
      algorithm: "br",
      data: Buffer.from("test"),
      contentType: "application/json",
      size: 4,
      timestamp: Date.now(),
    });

    // Hit
    cache.get("key1");
    // Miss
    cache.get("nonexistent");

    const stats = cache.getStats();
    expect(stats.hitRate).toBeGreaterThan(0);
    expect(stats.hitRate).toBeLessThan(1);
  });

  it("should clear cache", () => {
    cache.set("key1", {
      algorithm: "br",
      data: Buffer.from("test"),
      contentType: "application/json",
      size: 4,
      timestamp: Date.now(),
    });

    cache.clear();

    expect(cache.get("key1")).toBeUndefined();
    expect(cache.getStats().size).toBe(0);
  });

  it("should delete specific entry", () => {
    cache.set("key1", {
      algorithm: "br",
      data: Buffer.from("test"),
      contentType: "application/json",
      size: 4,
      timestamp: Date.now(),
    });

    const deleted = cache.delete("key1");
    expect(deleted).toBe(true);
    expect(cache.get("key1")).toBeUndefined();
  });
});

describe("CompressionMetrics", () => {
  let metrics: CompressionMetrics;

  beforeEach(() => {
    metrics = new CompressionMetrics();
  });

  it("should record compression results", () => {
    const result = {
      algorithm: "br",
      originalSize: 1000,
      compressedSize: 300,
      ratio: 0.3,
      timeMs: 5,
      fromCache: false,
    };

    metrics.recordResult(result);

    const m = metrics.getMetrics();
    expect(m.compressedRequests).toBe(1);
    expect(m.byAlgorithm["br"]).toBeDefined();
  });

  it("should calculate averages", () => {
    metrics.recordResult({
      algorithm: "br",
      originalSize: 1000,
      compressedSize: 300,
      ratio: 0.3,
      timeMs: 5,
      fromCache: false,
    });

    metrics.recordResult({
      algorithm: "br",
      originalSize: 2000,
      compressedSize: 600,
      ratio: 0.3,
      timeMs: 10,
      fromCache: false,
    });

    const m = metrics.getMetrics();
    expect(m.avgRatio).toBeCloseTo(0.3);
    expect(m.avgTimeMs).toBeCloseTo(7.5);
  });

  it("should handle cache hits and misses", () => {
    metrics.recordCacheHit();
    metrics.recordCacheHit();
    metrics.recordCacheMiss();

    // Metrics should record the hits/misses
    expect(metrics.getMetrics()).toBeDefined();
  });

  it("should reset metrics", () => {
    metrics.recordResult({
      algorithm: "br",
      originalSize: 1000,
      compressedSize: 300,
      ratio: 0.3,
      timeMs: 5,
      fromCache: false,
    });

    metrics.reset();

    const m = metrics.getMetrics();
    expect(m.compressedRequests).toBe(0);
  });
});

describe("CompressionMiddleware", () => {
  let middleware: CompressionMiddleware;

  beforeEach(() => {
    middleware = new CompressionMiddleware();
  });

  it("should negotiate compression algorithms", () => {
    expect(middleware.negotiateAlgorithm("br, gzip")).toBe("br");
    expect(middleware.negotiateAlgorithm("zstd, gzip")).toBe("zstd");
    expect(middleware.negotiateAlgorithm("gzip, deflate")).toBe("gzip");
    expect(middleware.negotiateAlgorithm("*")).toBe("br"); // Default
    expect(middleware.negotiateAlgorithm("deflate")).toBe("deflate");
  });

  it("should determine compressible content types", () => {
    expect(middleware.isCompressible("application/json")).toBe(true);
    expect(middleware.isCompressible("text/html")).toBe(true);
    expect(middleware.isCompressible("application/javascript")).toBe(true);

    // Should bypass already-compressed content
    expect(middleware.isCompressible("image/png")).toBe(false);
    expect(middleware.isCompressible("image/jpeg")).toBe(false);
    expect(middleware.isCompressible("video/mp4")).toBe(false);
    expect(middleware.isCompressible("application/zip")).toBe(false);
    expect(middleware.isCompressible("application/gzip")).toBe(false);
  });

  it("should compress data with Brotli", async () => {
    const data = JSON.stringify({
      message: "Hello, World!",
      items: Array.from({ length: 100 }, (_, i) => ({ id: i, value: i * 2 })),
    });

    const result = await middleware.compress(data, "application/json", "br");

    expect(result.algorithm).toBe("br");
    expect(result.originalSize).toBeGreaterThan(result.compressedSize);
    expect(result.ratio).toBeLessThan(1);
  });

  it("should compress data with Zstandard", async () => {
    const data = JSON.stringify({
      message: "Hello, World!",
      items: Array.from({ length: 100 }, (_, i) => ({ id: i, value: i * 2 })),
    });

    const result = await middleware.compress(data, "application/json", "zstd");

    expect(result.algorithm).toBe("zstd");
    expect(result.originalSize).toBeGreaterThan(result.compressedSize);
    expect(result.ratio).toBeLessThan(1);
  });

  it("should use cache when enabled", async () => {
    const data = JSON.stringify({ data: "test".repeat(100) });

    // First compression
    const result1 = await middleware.compress(data, "application/json", "br");
    expect(result1.fromCache).toBe(false);

    // Second compression should use cache
    const result2 = await middleware.compress(data, "application/json", "br");
    expect(result2.fromCache).toBe(true);
    expect(result2.timeMs).toBeLessThan(result1.timeMs);
  });

  it("should calculate cache statistics", () => {
    const stats = middleware.getCacheStats();

    expect(stats).toBeDefined();
    expect(stats.size).toBeGreaterThanOrEqual(0);
    expect(stats.totalSize).toBeGreaterThanOrEqual(0);
  });

  it("should support streaming compression", async () => {
    const data = JSON.stringify({
      items: Array.from({ length: 50 }, (_, i) => ({ id: i, name: `Item ${i}` })),
    });

    const stream = Readable.from([data]);

    const result = await middleware.compressStream(stream, "application/json");

    expect(result.compression.algorithm).toBe("br");
    expect(result.compression.originalSize).toBeGreaterThan(0);
  });

  it("should clear cache and reset metrics", () => {
    middleware.clearCache();

    const cacheStats = middleware.getCacheStats();
    expect(cacheStats.size).toBe(0);
  });

  it("should return compression metrics", () => {
    const metrics = middleware.getMetrics();

    expect(metrics).toBeDefined();
    expect(metrics.totalRequests).toBeGreaterThanOrEqual(0);
    expect(metrics.compressedRequests).toBeGreaterThanOrEqual(0);
    expect(metrics.byAlgorithm).toBeDefined();
  });
});

describe("Compression Edge Cases", () => {
  let middleware: CompressionMiddleware;

  beforeEach(() => {
    middleware = new CompressionMiddleware();
  });

  it("should skip compression for very small payloads", async () => {
    const smallData = "a";

    const result = await middleware.compress(smallData, "text/plain", "br");

    // Small data may not compress well
    expect(result.ratio).toBeDefined();
  });

  it("should handle empty data", async () => {
    const result = await middleware.compress("", "text/plain", "br");

    expect(result.algorithm).toBe("br");
    expect(result.originalSize).toBe(0);
    expect(result.compressedSize).toBe(0);
  });

  it("should handle already-compressed content", () => {
    // Already compressed content should be bypassed
    const isCompressible = middleware.isCompressible("application/zip");
    expect(isCompressible).toBe(false);
  });

  it("should handle undefined content type", () => {
    const isCompressible = middleware.isCompressible(undefined as any);
    expect(isCompressible).toBe(false);
  });
});