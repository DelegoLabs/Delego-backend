/**
 * Advanced Response Compression Module
 *
 * Implements Brotli, Zstandard, and automatic algorithm negotiation.
 * Features:
 *   - Automatic compression algorithm negotiation via Accept-Encoding
 *   - Per-content-type compression level configuration
 *   - Compression cache for static responses
 *   - Streaming compression for large payloads
 *   - Compression metrics and monitoring
 *   - Bypass for already-compressed content (images, videos)
 */

export {
  CompressionMiddleware,
  CompressionCache,
  CompressionMetrics,
  type CompressionConfig,
  type CompressionResult,
  type CompressionMetrics as CompressionMetricsType,
} from "./compression.js";

export * from "./types.js";