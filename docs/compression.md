# Advanced Response Compression

This document describes the advanced response compression implementation with Brotli, Zstandard, and automatic negotiation.

## Overview

The compression module provides:

- **Multiple Algorithms**: Brotli, Zstandard, Gzip, and Deflate support
- **Automatic Negotiation**: Automatic algorithm selection via `Accept-Encoding`
- **Per-Content-Type Configuration**: Different compression levels for different content types
- **Compression Cache**: Caching of compressed responses for static content
- **Streaming Compression**: Support for large payloads via streaming
- **Metrics & Monitoring**: Prometheus-compatible metrics for observability
- **Bypass for Already-Compressed Content**: Automatic skip for images, videos, etc.

## Installation

```bash
pnpm add zstd
```

## Quick Start

### Basic Setup

```typescript
import { createServer } from "node:http";
import { CompressionMiddleware, type CompressionConfig } from "@delegolabs/utils";

const config: CompressionConfig = {
  algorithms: ["br", "zstd", "gzip"],
  defaultAlgorithm: "br",
  level: { br: 4, zstd: 3, gzip: 6 },
  minSizeBytes: 1024,
  contentTypes: [
    "application/json",
    "text/html",
    "text/plain",
    "application/javascript",
  ],
  cacheEnabled: true,
  cacheMaxSizeBytes: 100 * 1024 * 1024,
  cacheTtlSeconds: 3600,
};

const compression = new CompressionMiddleware(config);

const server = createServer((req, res) => {
  compression.handler(req, res, () => {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ message: "Hello, World!" }));
  });
});

server.listen(3000);
```

### Express Integration

```typescript
import express from "express";
import { createCompressionMiddleware } from "@delegolabs/utils";

const app = express();

app.use(createCompressionMiddleware({
  config: {
    algorithms: ["br", "zstd"],
    defaultAlgorithm: "br",
    level: { br: 4, zstd: 3 },
    minSizeBytes: 512,
  },
}));

app.get("/api/data", (req, res) => {
  res.json({ data: "Large response..." });
});

app.listen(3000);
```

## API Reference

### CompressionMiddleware

#### Constructor

```typescript
constructor(config?: Partial<CompressionConfig>)
```

Creates a new compression middleware with optional configuration.

#### negotiateAlgorithm(acceptEncoding: string): string

Selects the best compression algorithm based on the `Accept-Encoding` header.

```typescript
const algorithm = compression.negotiateAlgorithm("br, zstd, gzip");
// Returns: "br" (highest priority supported algorithm)
```

#### isCompressible(contentType: string): boolean

Checks if a content type should be compressed.

```typescript
compression.isCompressible("application/json"); // true
compression.isCompressible("image/png"); // false (bypass)
```

#### compress(data: Buffer | string, contentType: string, algorithm?: string): Promise<CompressionResult>

Compresses data with the specified algorithm.

```typescript
const result = await compression.compress(
  Buffer.from("Hello, World!"),
  "text/plain",
  "br"
);

console.log(result);
// {
//   algorithm: "br",
//   originalSize: 13,
//   compressedSize: 5,
//   ratio: 0.38,
//   timeMs: 2,
//   fromCache: false
// }
```

#### compressStream(readable: Readable, contentType: string, algorithm?: string): Promise<StreamCompressionResult>

Compresses data from a readable stream.

```typescript
const stream = Readable.from(["data1", "data2", "data3"]);
const result = await compression.compressStream(stream, "text/plain");

console.log(result.compression);
// { algorithm: "br", originalSize: 15 }
```

#### handler(req: any, res: any, next?: () => void): Promise<void>

Express-compatible middleware handler.

#### getMetrics(): CompressionMetrics

Returns compression metrics.

```typescript
const metrics = compression.getMetrics();
console.log(metrics);
// {
//   totalRequests: 1000,
//   compressedRequests: 800,
//   avgRatio: 0.45,
//   avgTimeMs: 3.2,
//   byAlgorithm: { br: { count: 500, avgRatio: 0.35, avgTimeMs: 2.1 } },
//   cacheHitRate: 0.85
// }
```

#### getCacheStats(): object

Returns cache statistics.

```typescript
const stats = compression.getCacheStats();
console.log(stats);
// { size: 100, totalSize: 50000, hitRate: 0.85, hits: 85, misses: 15 }
```

#### clearCache(): void

Clears the compression cache and resets metrics.

```typescript
compression.clearCache();
```

### CompressionCache

#### get(key: string): CompressionCacheEntry | undefined

Retrieves a cached entry.

#### set(key: string, entry: CompressionCacheEntry): void

Stores an entry in the cache.

#### getHitRate(): number

Returns the cache hit rate (0-1).

#### getStats(): object

Returns cache statistics.

#### clear(): void

Clears the cache.

#### delete(key: string): boolean

Deletes a specific entry.

### CompressionMetrics

#### recordResult(result: CompressionResult): void

Records a compression result.

#### recordCacheHit(): void

Records a cache hit.

#### recordCacheMiss(): void

Records a cache miss.

#### getMetrics(): CompressionMetrics

Returns current metrics.

#### reset(): void

Resets all metrics.

## Configuration

### CompressionConfig

```typescript
interface CompressionConfig {
  algorithms: Array<"br" | "zstd" | "gzip" | "deflate">;
  defaultAlgorithm: string;
  level: Record<string, number>; // per algorithm
  minSizeBytes: number;
  contentTypes: string[];
  cacheEnabled: boolean;
  cacheMaxSizeBytes: number;
  cacheTtlSeconds: number;
}
```

### Example Configuration

```typescript
const config: CompressionConfig = {
  // Supported algorithms (priority order)
  algorithms: ["br", "zstd", "gzip", "deflate"],
  
  // Default algorithm if none specified
  defaultAlgorithm: "br",
  
  // Compression levels (1-11 for brotli, 1-22 for zstd, 1-9 for gzip)
  level: {
    br: 4,    // Balanced brotli
    zstd: 3,  // Fast zstd
    gzip: 6,  // Standard gzip
    deflate: 6,
  },
  
  // Minimum response size to compress
  minSizeBytes: 1024, // 1KB
  
  // Content types to compress
  contentTypes: [
    "application/json",
    "application/javascript",
    "text/html",
    "text/plain",
    "text/css",
    "application/xml",
  ],
  
  // Cache settings
  cacheEnabled: true,
  cacheMaxSizeBytes: 100 * 1024 * 1024, // 100MB
  cacheTtlSeconds: 3600, // 1 hour
};
```

## Compression Algorithms

### Brotli (br)

- **Best compression ratio** among all algorithms
- **Slower** than gzip/zstd but better compression
- **Best for**: Static content, JSON, HTML
- **Level**: 1-11 (default: 4)

### Zstandard (zstd)

- **Fast compression** with good ratio
- **Balanced** between speed and compression
- **Best for**: Dynamic content, APIs
- **Level**: 1-22 (default: 3)

### Gzip

- **Widely supported** across all clients
- **Moderate** compression and speed
- **Best for**: Fallback algorithm
- **Level**: 1-9 (default: 6)

### Deflate

- **Legacy algorithm**
- **Lower compression** than gzip
- **Use only if needed**
- **Level**: 1-9 (default: 6)

## Accept-Encoding Negotiation

The middleware automatically selects the best algorithm based on the client's `Accept-Encoding` header:

```
Accept-Encoding: br, zstd, gzip, deflate

Result: br (highest priority supported)
```

If a client supports `*`, the default algorithm is used.

## Compression Cache

The compression cache stores compressed responses to avoid recompression:

```typescript
// First request - cache miss
GET /api/data
→ X-Compression-Cache: MISS
→ Compressed response

// Second request - cache hit
GET /api/data
→ X-Compression-Cache: HIT
→ Cached compressed response
```

### Cache Busting

```typescript
// Clear cache for specific key
compression.clearCache();

// Or delete specific entry
compression["generateCacheKey"]() // Use internal method
```

## Streaming Compression

For large payloads, use streaming compression:

```typescript
import { createReadStream } from "fs";
import { CompressionMiddleware } from "@delegolabs/utils";

const compression = new CompressionMiddleware();

const stream = createReadStream("large-file.json");

const result = await compression.compressStream(stream, "application/json");
```

## Metrics & Monitoring

### Prometheus Metrics

The module integrates with Prometheus for monitoring:

```typescript
import { generatePrometheusMetrics, evaluateCompressionHealth } from "@delegolabs/utils";

const metrics = compression.getMetrics();

// Generate Prometheus text format
const prometheusText = generatePrometheusMetrics(metrics);

// Check health
const health = evaluateCompressionHealth(metrics);
console.log(health.healthy); // true/false
```

### Prometheus Endpoint

```typescript
app.get("/metrics", (req, res) => {
  const metrics = compression.getMetrics();
  res.type("text/plain");
  res.end(generatePrometheusMetrics(metrics));
});
```

### Metrics Endpoints

| Endpoint | Description |
|----------|-------------|
| `/metrics` | Prometheus-formatted metrics |
| `/metrics/json` | JSON-formatted metrics |
| `/metrics/health` | Health check with metrics |

## Performance Tuning

### Optimize Compression Levels

| Use Case | Algorithm | Level |
|----------|-----------|-------|
| Static files | br | 4-6 |
| API responses | zstd | 3 |
| Fallback | gzip | 6 |

### Cache Configuration

| Use Case | TTL | Max Size |
|----------|-----|----------|
| Static content | 1h | 100MB |
| Dynamic content | 5m | 50MB |
| API responses | 1m | 25MB |

### Content Type Configuration

Only compress text-based content:

```typescript
contentTypes: [
  "application/json",
  "application/javascript",
  "text/html",
  "text/plain",
  "text/css",
  "text/xml",
  "application/xml",
  "application/graphql+json",
]

// Skip binary content
// - images/*, videos/*, audio/*
// - application/zip, application/gzip
// - application/octet-stream
```

## Bypass Rules

The middleware automatically bypasses compression for:

- **Images**: `image/*`
- **Videos**: `video/*`
- **Audio**: `audio/*`
- **Archives**: `application/zip`, `application/gzip`
- **Binary**: `application/octet-stream`
- **WASM**: `application/wasm`

## Acceptance Criteria

### Brotli/Zstd Negotiate Automatically ✅

```typescript
compression.negotiateAlgorithm("br, zstd, gzip"); // Returns "br"
compression.negotiateAlgorithm("zstd, gzip"); // Returns "zstd"
compression.negotiateAlgorithm("gzip"); // Returns "gzip"
```

### Compression Ratio > 70% for JSON ✅

```typescript
const data = JSON.stringify({ items: Array.from({ length: 100 }) });
const result = await compression.compress(data, "application/json", "br");
expect(result.ratio).toBeLessThan(0.3); // >70% compression
```

### Compression Adds < 5ms Latency ✅

```typescript
const metrics = compression.getMetrics();
expect(metrics.avgTimeMs).toBeLessThan(5);
```

### Cache Hit Rate > 80% for Static ✅

```typescript
const stats = compression.getCacheStats();
expect(stats.hitRate).toBeGreaterThan(0.8);
```

### Metrics in Prometheus ✅

```typescript
const prometheusText = generatePrometheusMetrics(metrics);
expect(prometheusText).toContain("compression_requests_total");
expect(prometheusText).toContain("compression_ratio_avg");
```

### Bypass for Images/Videos ✅

```typescript
expect(compression.isCompressible("image/png")).toBe(false);
expect(compression.isCompressible("video/mp4")).toBe(false);
expect(compression.isCompressible("image/jpeg")).toBe(false);
```

## Troubleshooting

### Compression Not Working

1. Check `minSizeBytes` - responses below threshold are not compressed
2. Check `contentTypes` - ensure the content type is in the list
3. Check `Accept-Encoding` header - client must support compression

### High Latency

1. Reduce compression level (e.g., `br: 2` instead of `br: 4`)
2. Use faster algorithm (zstd instead of br)
3. Enable caching

### Low Cache Hit Rate

1. Increase cache size
2. Increase TTL
3. Use cache-friendly caching headers

## Examples

### Full Express Application

```typescript
import express from "express";
import { createCompressionMiddleware } from "@delegolabs/utils";

const app = express();

// Compression middleware
app.use(createCompressionMiddleware({
  config: {
    algorithms: ["br", "zstd"],
    defaultAlgorithm: "br",
    level: { br: 4, zstd: 3 },
    minSizeBytes: 512,
    contentTypes: [
      "application/json",
      "application/javascript",
      "text/html",
      "text/plain",
    ],
    cacheEnabled: true,
  },
}));

// API routes
app.get("/api/data", (req, res) => {
  res.json({ data: "Some data..." });
});

// Metrics endpoint
app.get("/metrics", (req, res) => {
  const compression = app.get("compression");
  const metrics = compression.getMetrics();
  res.json(metrics);
});

app.listen(3000);
```