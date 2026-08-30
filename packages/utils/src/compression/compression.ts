/**
 * Advanced Response Compression Implementation
 *
 * Provides Brotli, Zstandard compression with automatic negotiation and caching.
 */

import { createGzip, createBrotliCompress, createZstdCompress, type Gzip, type BrotliCompress, type ZstdCompress } from "zlib";
import { Readable, type Transform } from "stream";
import { createLogger } from "../logger.js";
import { ServiceMetricsRegistry } from "../metrics/serviceMetrics.js";
import type {
  CompressionConfig,
  CompressionResult,
  CompressionMetrics,
  CompressionMetricsState,
  CompressionCacheEntry,
} from "./types.js";

// ─────────────────────────────────────────────────────────────────────────────
// Default Configuration
// ─────────────────────────────────────────────────────────────────────────────

const DEFAULT_CONFIG: CompressionConfig = {
  algorithms: ["br", "zstd", "gzip", "deflate"],
  defaultAlgorithm: "br",
  level: { br: 4, zstd: 3, gzip: 6, deflate: 6 },
  minSizeBytes: 1024, // 1KB minimum
  contentTypes: [
    "application/json",
    "application/javascript",
    "application/xml",
    "text/plain",
    "text/html",
    "text/css",
    "application/graphql+json",
  ],
  cacheEnabled: true,
  cacheMaxSizeBytes: 100 * 1024 * 1024, // 100MB
  cacheTtlSeconds: 3600, // 1 hour
};

// ─────────────────────────────────────────────────────────────────────────────
// Compression Cache
// ─────────────────────────────────────────────────────────────────────────────

export class CompressionCache {
  private entries = new Map<string, CompressionCacheEntry>();
  private totalSize = 0;
  private maxSize: number;
  private ttl: number;
  private hits = 0;
  private misses = 0;

  constructor(config: Partial<CompressionConfig> = {}) {
    this.maxSize = config.cacheMaxSizeBytes ?? DEFAULT_CONFIG.cacheMaxSizeBytes;
    this.ttl = config.cacheTtlSeconds ?? DEFAULT_CONFIG.cacheTtlSeconds;
  }

  get(key: string): CompressionCacheEntry | undefined {
    const entry = this.entries.get(key);
    if (!entry) {
      this.misses++;
      return undefined;
    }

    // Check TTL
    if (Date.now() - entry.timestamp > this.ttl * 1000) {
      this.entries.delete(key);
      this.totalSize -= entry.size;
      this.misses++;
      return undefined;
    }

    this.hits++;
    return entry;
  }

  set(key: string, entry: CompressionCacheEntry): void {
    // Evict old entries if cache is full
    while (this.totalSize + entry.size > this.maxSize && this.entries.size > 0) {
      const oldestKey = this.entries.keys().next().value;
      const oldest = this.entries.get(oldestKey)!;
      this.entries.delete(oldestKey);
      this.totalSize -= oldest.size;
    }

    this.entries.set(key, entry);
    this.totalSize += entry.size;
  }

  getHitRate(): number {
    const total = this.hits + this.misses;
    return total > 0 ? this.hits / total : 0;
  }

  getStats() {
    return {
      size: this.entries.size,
      totalSize: this.totalSize,
      hitRate: this.getHitRate(),
      hits: this.hits,
      misses: this.misses,
    };
  }

  clear(): void {
    this.entries.clear();
    this.totalSize = 0;
    this.hits = 0;
    this.misses = 0;
  }

  delete(key: string): boolean {
    const entry = this.entries.get(key);
    if (entry) {
      this.entries.delete(key);
      this.totalSize -= entry.size;
      return true;
    }
    return false;
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Compression Metrics
// ─────────────────────────────────────────────────────────────────────────────

export class CompressionMetrics {
  private state: CompressionMetricsState;
  private metricsRegistry: ServiceMetricsRegistry | null;

  constructor(metricsRegistry?: ServiceMetricsRegistry) {
    this.state = {
      totalRequests: 0,
      compressedRequests: 0,
      ratios: [],
      times: [],
      byAlgorithm: new Map(),
    };
    this.metricsRegistry = metricsRegistry || null;

    // Initialize Prometheus metrics if registry provided
    if (this.metricsRegistry) {
      this.initMetrics();
    }
  }

  private initMetrics(): void {
    // Compression ratio histogram
    this.metricsRegistry.histogram("compression_ratio");

    // Compression time histogram
    this.metricsRegistry.histogram("compression_time_seconds");

    // Requests by algorithm
    this.metricsRegistry.counter("compression_requests_total");

    // Cache hits
    this.metricsRegistry.counter("compression_cache_hits_total");
    this.metricsRegistry.counter("compression_cache_misses_total");

    // Compression enabled requests
    this.metricsRegistry.counter("compression_enabled_requests_total");
  }

  recordResult(result: CompressionResult): void {
    this.state.totalRequests++;

    if (result.compressedSize < result.originalSize) {
      this.state.compressedRequests++;
      this.state.ratios.push(result.ratio);
      this.state.times.push(result.timeMs);

      // Update by-algorithm stats
      let algoStats = this.state.byAlgorithm.get(result.algorithm);
      if (!algoStats) {
        algoStats = { count: 0, ratios: [], times: [] };
        this.state.byAlgorithm.set(result.algorithm, algoStats);
      }
      algoStats.count++;
      algoStats.ratios.push(result.ratio);
      algoStats.times.push(result.timeMs);

      // Record Prometheus metrics
      if (this.metricsRegistry) {
        this.metricsRegistry.histogram("compression_ratio").observe(result.ratio);
        this.metricsRegistry.histogram("compression_time_seconds").observe(result.timeMs / 1000);
        this.metricsRegistry.counter("compression_requests_total").inc(1, { algorithm: result.algorithm });
      }
    }

    if (this.metricsRegistry) {
      this.metricsRegistry.counter("compression_enabled_requests_total").inc();
    }
  }

  recordCacheHit(): void {
    if (this.metricsRegistry) {
      this.metricsRegistry.counter("compression_cache_hits_total").inc();
    }
  }

  recordCacheMiss(): void {
    if (this.metricsRegistry) {
      this.metricsRegistry.counter("compression_cache_misses_total").inc();
    }
  }

  getMetrics(): CompressionMetrics {
    const { ratios, times, byAlgorithm } = this.state;

    const avgRatio = ratios.length > 0 ? ratios.reduce((a, b) => a + b, 0) / ratios.length : 1;
    const avgTimeMs = times.length > 0 ? times.reduce((a, b) => a + b, 0) / times.length : 0;

    const byAlgorithmMetrics: Record<string, { count: number; avgRatio: number; avgTimeMs: number }> = {};
    for (const [algorithm, stats] of byAlgorithm) {
      byAlgorithmMetrics[algorithm] = {
        count: stats.count,
        avgRatio: stats.ratios.length > 0 ? stats.ratios.reduce((a, b) => a + b, 0) / stats.ratios.length : 1,
        avgTimeMs: stats.times.length > 0 ? stats.times.reduce((a, b) => a + b, 0) / stats.times.length : 0,
      };
    }

    return {
      totalRequests: this.state.totalRequests,
      compressedRequests: this.state.compressedRequests,
      avgRatio,
      avgTimeMs,
      byAlgorithm: byAlgorithmMetrics,
      cacheHitRate: 0, // Will be set from cache
    };
  }

  reset(): void {
    this.state = {
      totalRequests: 0,
      compressedRequests: 0,
      ratios: [],
      times: [],
      byAlgorithm: new Map(),
    };
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Compression Middleware
// ─────────────────────────────────────────────────────────────────────────────

export class CompressionMiddleware {
  private config: CompressionConfig;
  private cache: CompressionCache;
  private metrics: CompressionMetrics;

  constructor(config: Partial<CompressionConfig> = {}) {
    this.config = { ...DEFAULT_CONFIG, ...config };
    this.cache = new CompressionCache(config);
    this.metrics = new CompressionMetrics();
  }

  getMetrics(): CompressionMetrics {
    const metrics = this.metrics.getMetrics();
    metrics.cacheHitRate = this.cache.getHitRate();
    return metrics;
  }

  // ─── Compression Algorithm Selection ────────────────────────────────────

  negotiateAlgorithm(acceptEncoding: string): string {
    const encodings = acceptEncoding.split(",").map((e) => e.trim().toLowerCase());

    // Priority order: br > zstd > gzip > deflate
    for (const algo of ["br", "zstd", "gzip", "deflate"]) {
      if (encodings.includes(algo) || encodings.includes("*")) {
        return algo;
      }
    }

    return this.config.defaultAlgorithm;
  }

  // ─── Stream Creation ────────────────────────────────────────────────────

  createCompressor(algorithm: string): Transform {
    const level = this.config.level[algorithm] ?? 6;

    switch (algorithm) {
      case "br":
        return createBrotliCompress({ quality: level });
      case "zstd":
        return createZstdCompress({ level });
      case "gzip":
        return createGzip({ level });
      case "deflate":
        return new (require("zlib").Deflate)({ level });
      default:
        throw new Error(`Unsupported algorithm: ${algorithm}`);
    }
  }

  // ─── Content Type Detection ─────────────────────────────────────────────

  isCompressible(contentType: string): boolean {
    if (!contentType) return false;

    // Bypass for already-compressed content
    const bypassTypes = [
      "image/",
      "video/",
      "audio/",
      "application/zip",
      "application/gzip",
      "application/x-gzip",
      "application/x-zip-compressed",
      "application/wasm",
      "application/octet-stream",
    ];

    for (const bypass of bypassTypes) {
      if (contentType.startsWith(bypass)) {
        return false;
      }
    }

    // Check if content type is in allowed list
    return this.config.contentTypes.some((ct) => contentType.includes(ct));
  }

  // ─── Response Compression ───────────────────────────────────────────────

  async compress(
    data: Buffer | string,
    contentType: string,
    algorithm?: string
  ): Promise<CompressionResult> {
    const startTime = Date.now();

    const buffer = Buffer.isBuffer(data) ? data : Buffer.from(data);
    const originalSize = buffer.length;

    // Check cache first
    if (this.config.cacheEnabled) {
      const cacheKey = this.generateCacheKey(buffer, contentType, algorithm || this.config.defaultAlgorithm);
      const cached = this.cache.get(cacheKey);

      if (cached) {
        const timeMs = Date.now() - startTime;
        this.metrics.recordCacheHit();

        return {
          algorithm: cached.algorithm,
          originalSize,
          compressedSize: cached.size,
          ratio: cached.size / originalSize,
          timeMs,
          fromCache: true,
        };
      }
    }

    // Determine algorithm
    const algo = algorithm || this.negotiateAlgorithm("br, zstd, gzip, deflate");
    const compressor = this.createCompressor(algo);

    // Compress data
    const compressedBuffers: Buffer[] = [];
    const compressed = new Promise<Buffer>((resolve, reject) => {
      let result = Buffer.alloc(0);

      compressor.on("data", (chunk: Buffer) => {
        compressedBuffers.push(chunk);
      });

      compressor.on("end", () => {
        result = Buffer.concat(compressedBuffers);
        resolve(result);
      });

      compressor.on("error", reject);

      compressor.write(buffer);
      compressor.end();
    });

    try {
      const compressedBuffer = await compressed;
      const timeMs = Date.now() - startTime;

      const result: CompressionResult = {
        algorithm: algo,
        originalSize,
        compressedSize: compressedBuffer.length,
        ratio: compressedBuffer.length / originalSize,
        timeMs,
        fromCache: false,
      };

      // Cache result if beneficial
      if (this.config.cacheEnabled && compressedBuffer.length < originalSize) {
        const cacheKey = this.generateCacheKey(buffer, contentType, algo);
        this.cache.set(cacheKey, {
          algorithm: algo,
          data: compressedBuffer,
          contentType,
          size: compressedBuffer.length,
          timestamp: Date.now(),
        });
      }

      this.metrics.recordResult(result);
      return result;
    } catch (err) {
      this.metrics.recordCacheMiss();
      throw new Error(`Compression failed: ${(err as Error).message}`);
    }
  }

  // ─── Streaming Compression ──────────────────────────────────────────────

  async compressStream(
    readable: Readable,
    contentType: string,
    algorithm?: string
  ): Promise<StreamCompressionResult> {
    const algo = algorithm || this.negotiateAlgorithm("br, zstd, gzip, deflate");
    const compressor = this.createCompressor(algo);

    const chunks: Buffer[] = [];
    let originalSize = 0;

    return new Promise((resolve, reject) => {
      readable.on("data", (chunk: Buffer) => {
        originalSize += chunk.length;
        chunks.push(chunk);
      });

      readable.on("end", () => {
        const fullBuffer = Buffer.concat(chunks);
        resolve({ readable: fullBuffer, compression: { algorithm: algo, originalSize } });
      });

      readable.on("error", reject);
    });
  }

  // ─── Cache Key Generation ───────────────────────────────────────────────

  private generateCacheKey(data: Buffer, contentType: string, algorithm: string): string {
    // Simple hash-based key
    const crypto = require("crypto");
    return `compression:${crypto.createHash("md5").update(data).digest("hex")}:${algorithm}`;
  }

  // ─── Middleware Handler ─────────────────────────────────────────────────

  handler(req: any, res: any, next?: (err?: any) => void) {
    return async (err?: any) => {
      if (err) {
        next?.(err);
        return;
      }

      // Get original writeHead and write
      const originalWriteHead = res.writeHead;
      const originalWrite = res.write.bind(res);
      const originalEnd = res.end.bind(res);

      let compressed = false;
      let contentType = "text/plain";
      let contentBuffer: Buffer | null = null;

      // Intercept writeHead to set headers
      res.writeHead = function (status: number, headers?: any) {
        contentType = headers?.["Content-Type"] || headers?.["content-type"] || "text/plain";
        return originalWriteHead.call(res, status, headers);
      };

      // Intercept write to buffer content
      res.write = function (chunk: any, encoding?: any) {
        if (!contentBuffer) {
          contentBuffer = Buffer.alloc(0);
        }
        const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk, encoding);
        contentBuffer = Buffer.concat([contentBuffer, buf]);
        return true; // Return true to continue
      };

      // Intercept end to compress and send
      res.end = function (chunk?: any, encoding?: any) {
        if (chunk) {
          if (!contentBuffer) {
            contentBuffer = Buffer.alloc(0);
          }
          const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk, encoding);
          contentBuffer = Buffer.concat([contentBuffer, buf]);
        }

        if (!contentBuffer || contentBuffer.length === 0) {
          return originalEnd.call(res);
        }

        // Check if compression should be applied
        if (
          contentBuffer.length >= this.config.minSizeBytes &&
          this.isCompressible(contentType)
        ) {
          const acceptEncoding = req.headers["accept-encoding"] || "";
          const algorithm = this.negotiateAlgorithm(acceptEncoding);

          if (this.config.algorithms.includes(algorithm as any)) {
            this.compress(contentBuffer, contentType, algorithm)
              .then((result) => {
                compressed = true;
                const headers: Record<string, string> = {
                  "Content-Encoding": algorithm,
                  "Vary": "Accept-Encoding",
                };

                if (result.fromCache) {
                  headers["X-Compression-Cache"] = "HIT";
                } else {
                  headers["X-Compression-Cache"] = "MISS";
                }

                originalWriteHead.call(res, 200, headers);
                originalWrite.call(res, result.algorithm === "br" ? Buffer.from([]) : result);
                originalEnd.call(res, result);
              })
              .catch(() => {
                originalWriteHead.call(res, 200, { "Content-Type": contentType });
                originalWrite.call(res, contentBuffer);
                originalEnd.call(res);
              });
          }
        }

        originalWriteHead.call(res, 200, { "Content-Type": contentType });
        originalWrite.call(res, contentBuffer);
        originalEnd.call(res);
      };

      next?.();
    };
  }

  // ─── Utility Methods ────────────────────────────────────────────────────

  getCacheStats() {
    return this.cache.getStats();
  }

  clearCache() {
    this.cache.clear();
    this.metrics.reset();
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Logger
// ─────────────────────────────────────────────────────────────────────────────

const log = createLogger("utils:compression", process.env.LOG_LEVEL ?? "info");