/**
 * Compression Types
 */

export interface CompressionConfig {
  algorithms: Array<"br" | "zstd" | "gzip" | "deflate">;
  defaultAlgorithm: string;
  level: Record<string, number>; // per algorithm
  minSizeBytes: number;
  contentTypes: string[];
  cacheEnabled: boolean;
  cacheMaxSizeBytes: number;
  cacheTtlSeconds: number;
}

export interface CompressionResult {
  algorithm: string;
  originalSize: number;
  compressedSize: number;
  ratio: number;
  timeMs: number;
  fromCache: boolean;
}

export interface CompressionMetrics {
  totalRequests: number;
  compressedRequests: number;
  avgRatio: number;
  avgTimeMs: number;
  byAlgorithm: Record<string, { count: number; avgRatio: number; avgTimeMs: number }>;
  cacheHitRate: number;
}

// ─────────────────────────────────────────────────────────────────────────────
// Internal types
// ─────────────────────────────────────────────────────────────────────────────

export interface CompressionCacheEntry {
  algorithm: string;
  data: Buffer;
  contentType: string;
  size: number;
  timestamp: number;
}

export interface StreamCompressionResult {
  readable: ReadableStream<Uint8Array>;
  compression: {
    algorithm: string;
    originalSize: number;
    compressedSize: number;
  };
}

export interface CompressionMetricsState {
  totalRequests: number;
  compressedRequests: number;
  ratios: number[];
  times: number[];
  byAlgorithm: Map<string, { count: number; ratios: number[]; times: number[] }>;
}