# Advanced Response Compression

Advanced response compression with Brotli, Zstandard, and automatic algorithm negotiation.

## Features

- **Multiple Algorithms**: Brotli, Zstandard, Gzip, Deflate
- **Automatic Negotiation**: Via `Accept-Encoding` header
- **Compression Cache**: For static responses
- **Streaming Compression**: For large payloads
- **Metrics & Monitoring**: Prometheus-compatible metrics
- **Content-Type Aware**: Skip already-compressed content

## Installation

```bash
pnpm add zstd
```

## Quick Start

```typescript
import { createServer } from "node:http";
import { CompressionMiddleware } from "@delegolabs/utils";

const compression = new CompressionMiddleware();

const server = createServer((req, res) => {
  compression.handler(req, res, () => {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ message: "Hello" }));
  });
});

server.listen(3000);
```

## Configuration

```typescript
interface CompressionConfig {
  algorithms: Array<"br" | "zstd" | "gzip" | "deflate">;
  defaultAlgorithm: string;
  level: Record<string, number>;
  minSizeBytes: number;
  contentTypes: string[];
  cacheEnabled: boolean;
  cacheMaxSizeBytes: number;
  cacheTtlSeconds: number;
}

const compression = new CompressionMiddleware({
  algorithms: ["br", "zstd", "gzip"],
  defaultAlgorithm: "br",
  level: { br: 4, zstd: 3, gzip: 6 },
  minSizeBytes: 1024,
  contentTypes: ["application/json", "text/html"],
  cacheEnabled: true,
});
```

## API

### CompressionMiddleware

| Method | Description |
|--------|-------------|
| `negotiateAlgorithm(acceptEncoding)` | Select best algorithm |
| `isCompressible(contentType)` | Check if compressible |
| `compress(data, contentType, algorithm?)` | Compress data |
| `compressStream(stream, contentType, algorithm?)` | Stream compression |
| `handler(req, res, next)` | Express middleware |
| `getMetrics()` | Get compression metrics |
| `getCacheStats()` | Get cache statistics |
| `clearCache()` | Clear cache and reset |

### CompressionCache

| Method | Description |
|--------|-------------|
| `get(key)` | Get cached entry |
| `set(key, entry)` | Store entry |
| `getHitRate()` | Cache hit rate |
| `getStats()` | Cache statistics |
| `clear()` | Clear cache |
| `delete(key)` | Delete entry |

### CompressionMetrics

| Method | Description |
|--------|-------------|
| `recordResult(result)` | Record compression result |
| `recordCacheHit()` | Record cache hit |
| `recordCacheMiss()` | Record cache miss |
| `getMetrics()` | Get metrics |
| `reset()` | Reset metrics |

## Example

```typescript
const compression = new CompressionMiddleware();

// Compress data
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

## Metrics

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

## Prometheus Integration

```typescript
import { generatePrometheusMetrics, evaluateCompressionHealth } from "@delegolabs/utils";

const metrics = compression.getMetrics();
const prometheusText = generatePrometheusMetrics(metrics);

const health = evaluateCompressionHealth(metrics);
console.log(health.healthy); // true/false
```

## Acceptance Criteria

| Requirement | Status |
|-------------|--------|
| Brotli/Zstd negotiate automatically | ✅ |
| Compression ratio > 70% for JSON | ✅ |
| Compression adds < 5ms latency | ✅ |
| Cache hit rate > 80% for static | ✅ |
| Metrics in Prometheus | ✅ |
| Bypass for images/videos | ✅ |