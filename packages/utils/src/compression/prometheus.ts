/**
 * Prometheus Metrics Integration for Compression
 *
 * Provides Prometheus-compatible metrics for compression operations.
 */

import type { CompressionMetrics } from "./types.js";

// ─────────────────────────────────────────────────────────────────────────────
// Prometheus Metrics
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Generate Prometheus metrics text for compression.
 */
export function generatePrometheusMetrics(metrics: CompressionMetrics): string {
  const lines: string[] = [];

  // Compression ratio histogram
  lines.push("# HELP compression_ratio The ratio of compressed size to original size");
  lines.push("# TYPE compression_ratio histogram");
  lines.push('compression_ratio_bucket{le="0.1"} 0');
  lines.push('compression_ratio_bucket{le="0.2"} 0');
  lines.push('compression_ratio_bucket{le="0.3"} 0');
  lines.push('compression_ratio_bucket{le="0.5"} 0');
  lines.push('compression_ratio_bucket{le="0.7"} 0');
  lines.push('compression_ratio_bucket{le="1.0"} 0');
  lines.push('compression_ratio_bucket{le="+Inf"} 0');
  lines.push("compression_ratio_sum 0");
  lines.push("compression_ratio_count 0");

  // Compression time histogram
  lines.push("# HELP compression_time_seconds Time spent compressing responses");
  lines.push("# TYPE compression_time_seconds histogram");
  lines.push('compression_time_seconds_bucket{le="0.001"} 0');
  lines.push('compression_time_seconds_bucket{le="0.005"} 0');
  lines.push('compression_time_seconds_bucket{le="0.01"} 0');
  lines.push('compression_time_seconds_bucket{le="0.05"} 0');
  lines.push('compression_time_seconds_bucket{le="0.1"} 0');
  lines.push('compression_time_seconds_bucket{le="+Inf"} 0');
  lines.push("compression_time_seconds_sum 0");
  lines.push("compression_time_seconds_count 0");

  // Total requests
  lines.push("# HELP compression_requests_total Total number of requests");
  lines.push("# TYPE compression_requests_total counter");
  lines.push(`compression_requests_total ${metrics.totalRequests}`);

  // Compressed requests
  lines.push("# HELP compression_compressed_total Requests that were compressed");
  lines.push("# TYPE compression_compressed_total counter");
  lines.push(`compression_compressed_total ${metrics.compressedRequests}`);

  // Average ratio
  lines.push("# HELP compression_ratio_avg Average compression ratio");
  lines.push("# TYPE compression_ratio_avg gauge");
  lines.push(`compression_ratio_avg ${metrics.avgRatio.toFixed(4)}`);

  // Average time
  lines.push("# HELP compression_time_avg Average compression time in ms");
  lines.push("# TYPE compression_time_avg gauge");
  lines.push(`compression_time_avg ${metrics.avgTimeMs.toFixed(2)}`);

  // Cache hit rate
  lines.push("# HELP compression_cache_hit_rate Cache hit rate");
  lines.push("# TYPE compression_cache_hit_rate gauge");
  lines.push(`compression_cache_hit_rate ${metrics.cacheHitRate.toFixed(4)}`);

  // By algorithm metrics
  for (const [algorithm, stats] of Object.entries(metrics.byAlgorithm)) {
    lines.push(`# HELP compression_${algorithm}_total Requests compressed with ${algorithm}`);
    lines.push(`# TYPE compression_${algorithm}_total counter`);
    lines.push(`compression_${algorithm}_total ${stats.count}`);

    lines.push(`# HELP compression_${algorithm}_ratio_avg Average ratio for ${algorithm}`);
    lines.push(`# TYPE compression_${algorithm}_ratio_avg gauge`);
    lines.push(`compression_${algorithm}_ratio_avg ${stats.avgRatio.toFixed(4)}`);

    lines.push(`# HELP compression_${algorithm}_time_avg Average time for ${algorithm}`);
    lines.push(`# TYPE compression_${algorithm}_time_avg gauge`);
    lines.push(`compression_${algorithm}_time_avg ${stats.avgTimeMs.toFixed(2)}`);
  }

  // Cache stats (if available)
  lines.push("# HELP compression_cache_hits_total Cache hits");
  lines.push("# TYPE compression_cache_hits_total counter");
  lines.push("compression_cache_hits_total 0");

  lines.push("# HELP compression_cache_misses_total Cache misses");
  lines.push("# TYPE compression_cache_misses_total counter");
  lines.push("compression_cache_misses_total 0");

  return lines.join("\n") + "\n";
}

/**
 * Generate JSON metrics for API endpoints.
 */
export function generateJsonMetrics(metrics: CompressionMetrics): object {
  return {
    totalRequests: metrics.totalRequests,
    compressedRequests: metrics.compressedRequests,
    avgRatio: metrics.avgRatio,
    avgTimeMs: metrics.avgTimeMs,
    cacheHitRate: metrics.cacheHitRate,
    byAlgorithm: metrics.byAlgorithm,
    summary: {
      totalSavedBytes: metrics.compressedRequests > 0
        ? Math.round((1 - metrics.avgRatio) * 100)
        : 0,
      efficiency: metrics.cacheHitRate > 0.8 ? "high" : metrics.cacheHitRate > 0.5 ? "medium" : "low",
    },
  };
}

/**
 * Format metrics for human-readable output.
 */
export function formatMetrics(metrics: CompressionMetrics): string {
  const lines: string[] = [];

  lines.push("Compression Metrics");
  lines.push("===================");
  lines.push(`Total Requests: ${metrics.totalRequests}`);
  lines.push(`Compressed Requests: ${metrics.compressedRequests}`);
  lines.push(`Average Ratio: ${metrics.avgRatio.toFixed(2)}`);
  lines.push(`Average Time: ${metrics.avgTimeMs.toFixed(2)}ms`);
  lines.push(`Cache Hit Rate: ${(metrics.cacheHitRate * 100).toFixed(1)}%`);
  lines.push("");

  if (Object.keys(metrics.byAlgorithm).length > 0) {
    lines.push("By Algorithm:");
    for (const [algorithm, stats] of Object.entries(metrics.byAlgorithm)) {
      lines.push(`  ${algorithm}:`);
      lines.push(`    Count: ${stats.count}`);
      lines.push(`    Avg Ratio: ${stats.avgRatio.toFixed(2)}`);
      lines.push(`    Avg Time: ${stats.avgTimeMs.toFixed(2)}ms`);
    }
    lines.push("");
  }

  const totalSaved = metrics.compressedRequests > 0
    ? Math.round((1 - metrics.avgRatio) * 100)
    : 0;

  lines.push(`Est. Bandwidth Saved: ${totalSaved}%`);
  lines.push(`Cache Efficiency: ${metrics.cacheHitRate > 0.8 ? "Excellent" : metrics.cacheHitRate > 0.5 ? "Good" : "Needs Attention"}`);

  return lines.join("\n");
}

// ─────────────────────────────────────────────────────────────────────────────
// Health Check Integration
// ─────────────────────────────────────────────────────────────────────────────

export interface CompressionHealth {
  healthy: boolean;
  ratioThresholdMet: boolean;
  latencyThresholdMet: boolean;
  cacheHitRateMet: boolean;
  metrics: CompressionMetrics;
}

/**
 * Evaluate compression health based on metrics.
 */
export function evaluateCompressionHealth(metrics: CompressionMetrics): CompressionHealth {
  const RATIO_THRESHOLD = 0.7; // 70% compression ratio
  const LATENCY_THRESHOLD = 5; // 5ms latency
  const CACHE_HIT_THRESHOLD = 0.8; // 80% cache hit rate

  const ratioMet = metrics.avgRatio <= RATIO_THRESHOLD;
  const latencyMet = metrics.avgTimeMs <= LATENCY_THRESHOLD;
  const cacheHitMet = metrics.cacheHitRate >= CACHE_HIT_THRESHOLD;

  return {
    healthy: ratioMet && latencyMet && cacheHitMet,
    ratioThresholdMet: ratioMet,
    latencyThresholdMet: latencyMet,
    cacheHitRateMet: cacheHitMet,
    metrics,
  };
}

/**
 * Generate health check response for compression.
 */
export function generateHealthResponse(health: CompressionHealth): object {
  return {
    healthy: health.healthy,
    components: {
      ratio: {
        healthy: health.ratioThresholdMet,
        value: health.metrics.avgRatio,
        threshold: 0.7,
      },
      latency: {
        healthy: health.latencyThresholdMet,
        value: health.metrics.avgTimeMs,
        threshold: 5,
      },
      cache: {
        healthy: health.cacheHitRateMet,
        value: health.metrics.cacheHitRate,
        threshold: 0.8,
      },
    },
    summary: {
      totalRequests: health.metrics.totalRequests,
      compressedRequests: health.metrics.compressedRequests,
      bandwidthSaved: Math.round((1 - health.metrics.avgRatio) * 100),
      cacheHitRate: Math.round(health.metrics.cacheHitRate * 100),
    },
  };
}