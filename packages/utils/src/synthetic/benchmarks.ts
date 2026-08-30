/**
 * Performance Benchmarks
 *
 * Tracks and analyzes performance metrics for synthetic checks.
 */

import { createLogger } from "../logger.js";
import type { CheckResult, PerformanceMetrics } from "./types.js";

// ─────────────────────────────────────────────────────────────────────────────
// Performance Benchmarks
// ─────────────────────────────────────────────────────────────────────────────

export class PerformanceBenchmarks {
  private metrics = new Map<string, CheckResult[]>();
  private windowSize = 1000; // Track last 1000 results per check

  // ─── Record Results ─────────────────────────────────────────────────────

  recordResults(checkId: string, results: CheckResult[]): void {
    let checkMetrics = this.metrics.get(checkId) || [];
    
    // Add new results
    checkMetrics = checkMetrics.concat(results);
    
    // Keep only recent results
    if (checkMetrics.length > this.windowSize) {
      checkMetrics = checkMetrics.slice(checkMetrics.length - this.windowSize);
    }
    
    this.metrics.set(checkId, checkMetrics);
  }

  // ─── Get Benchmarks ─────────────────────────────────────────────────────

  getBenchmarks(checkId: string, window: string): PerformanceMetrics | null {
    const results = this.metrics.get(checkId) || [];
    
    if (results.length === 0) return null;

    // Filter by time window
    const cutoff = this.getWindowCutoff(window);
    const windowResults = results.filter((r) => {
      const timestamp = Date.parse(r.timestamp);
      return timestamp > cutoff;
    });

    if (windowResults.length === 0) return null;

    const responseTimes = windowResults.map((r) => r.responseTime);
    
    // Sort for percentiles
    const sorted = [...responseTimes].sort((a, b) => a - b);
    
    const count = sorted.length;
    const avg = sorted.reduce((a, b) => a + b, 0) / count;
    const min = sorted[0];
    const max = sorted[count - 1];
    
    const p50Index = Math.floor(count * 0.50);
    const p95Index = Math.floor(count * 0.95);
    const p99Index = Math.floor(count * 0.99);

    return {
      checkId,
      location: "all",
      p50: sorted[p50Index],
      p95: sorted[p95Index],
      p99: sorted[p99Index],
      avg,
      min,
      max,
      count,
      timeWindow: window,
    };
  }

  // ─── Get By Location ────────────────────────────────────────────────────

  getBenchmarksByLocation(checkId: string, window: string): Record<string, PerformanceMetrics> {
    const results = this.metrics.get(checkId) || [];
    const cutoff = this.getWindowCutoff(window);

    // Group by location
    const byLocation = new Map<string, CheckResult[]>();
    for (const result of results) {
      if (Date.parse(result.timestamp) > cutoff) {
        const locResults = byLocation.get(result.location) || [];
        locResults.push(result);
        byLocation.set(result.location, locResults);
      }
    }

    const metrics: Record<string, PerformanceMetrics> = {};

    for (const [location, locResults] of byLocation) {
      if (locResults.length === 0) continue;

      const responseTimes = locResults.map((r) => r.responseTime);
      const sorted = [...responseTimes].sort((a, b) => a - b);
      
      const count = sorted.length;
      const avg = sorted.reduce((a, b) => a + b, 0) / count;
      
      metrics[location] = {
        checkId,
        location,
        p50: sorted[Math.floor(count * 0.50)],
        p95: sorted[Math.floor(count * 0.95)],
        p99: sorted[Math.floor(count * 0.99)],
        avg,
        min: sorted[0],
        max: sorted[count - 1],
        count,
        timeWindow: window,
      };
    }

    return metrics;
  }

  // ─── Availability by Location ───────────────────────────────────────────

  getAvailabilityByLocation(checkId: string, window: string): Record<string, number> {
    const results = this.metrics.get(checkId) || [];
    const cutoff = this.getWindowCutoff(window);

    const windowResults = results.filter((r) => Date.parse(r.timestamp) > cutoff);
    
    const byLocation = new Map<string, { success: number; total: number }>();

    for (const result of windowResults) {
      const locData = byLocation.get(result.location) || { success: 0, total: 0 };
      locData.total++;
      if (result.status === "success") {
        locData.success++;
      }
      byLocation.set(result.location, locData);
    }

    const result: Record<string, number> = {};

    for (const [location, data] of byLocation) {
      result[location] = data.total > 0 ? data.success / data.total : 0;
    }

    return result;
  }

  // ─── Helper Methods ─────────────────────────────────────────────────────

  private getWindowCutoff(window: string): number {
    const now = Date.now();
    
    switch (window) {
      case "1h":
        return now - 60 * 60 * 1000;
      case "6h":
        return now - 6 * 60 * 60 * 1000;
      case "24h":
        return now - 24 * 60 * 60 * 1000;
      case "7d":
        return now - 7 * 24 * 60 * 60 * 1000;
      case "30d":
        return now - 30 * 24 * 60 * 60 * 1000;
      default:
        return now - 1 * 60 * 60 * 1000; // Default to 1h
    }
  }

  // ─── Utility Methods ────────────────────────────────────────────────────

  getAllCheckIds(): string[] {
    return Array.from(this.metrics.keys());
  }

  clearMetrics(checkId?: string): void {
    if (checkId) {
      this.metrics.delete(checkId);
    } else {
      this.metrics.clear();
    }
  }

  // ─── Export Metrics ─────────────────────────────────────────────────────

  exportMetrics(): Record<string, CheckResult[]> {
    return Object.fromEntries(this.metrics);
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Logger
// ─────────────────────────────────────────────────────────────────────────────

const log = createLogger("utils:synthetic-benchmarks", process.env.LOG_LEVEL ?? "info");