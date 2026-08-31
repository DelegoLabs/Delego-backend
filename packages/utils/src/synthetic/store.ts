/**
 * Check Result Store - Stores and retrieves synthetic check results
 */

import { createLogger } from "../logger.js";
import type { CheckResult, SyntheticMetrics } from "./types.js";

// ─────────────────────────────────────────────────────────────────────────────
// In-Memory Store
// ─────────────────────────────────────────────────────────────────────────────

export class CheckResultStore {
  private results = new Map<string, CheckResult[]>();
  private maxResultsPerCheck = 10000;
  private maxAgeMs: number;

  constructor(options?: { maxResultsPerCheck?: number; maxAgeHours?: number }) {
    this.maxResultsPerCheck = options?.maxResultsPerCheck ?? 10000;
    this.maxAgeMs = (options?.maxAgeHours ?? 168) * 60 * 60 * 1000; // Default 7 days
  }

  // ─── Store Result ───────────────────────────────────────────────────────

  async storeResult(result: CheckResult): Promise<void> {
    let results = this.results.get(result.checkId) || [];
    
    // Add new result
    results.push(result);
    
    // Trim old results
    if (results.length > this.maxResultsPerCheck) {
      results = results.slice(results.length - this.maxResultsPerCheck);
    }
    
    // Remove old results based on age
    const cutoff = Date.now() - this.maxAgeMs;
    results = results.filter((r) => Date.parse(r.timestamp) > cutoff);
    
    this.results.set(result.checkId, results);
    
    log.debug("Check result stored", {
      checkId: result.checkId,
      location: result.location,
      status: result.status,
    });
  }

  // ─── Get Results ────────────────────────────────────────────────────────

  getResults(
    checkId: string,
    period?: { start: string; end: string }
  ): CheckResult[] {
    const results = this.results.get(checkId) || [];

    if (!period) {
      return results;
    }

    const start = Date.parse(period.start);
    const end = Date.parse(period.end);

    return results.filter((r) => {
      const timestamp = Date.parse(r.timestamp);
      return timestamp >= start && timestamp <= end;
    });
  }

  // ─── Get Recent Results ─────────────────────────────────────────────────

  getRecentResults(checkId: string, limit: number = 100): CheckResult[] {
    const results = this.results.get(checkId) || [];
    return results.slice(-limit);
  }

  // ─── Get Results by Location ────────────────────────────────────────────

  getResultsByLocation(
    checkId: string,
    location: string,
    period?: { start: string; end: string }
  ): CheckResult[] {
    const results = this.getResults(checkId, period);
    return results.filter((r) => r.location === location);
  }

  // ─── Get Stats ──────────────────────────────────────────────────────────

  getStats(checkId: string, period?: { start: string; end: string }): {
    total: number;
    success: number;
    failed: number;
    degraded: number;
    avgResponseTime: number;
    p95ResponseTime: number;
  } {
    const results = this.getResults(checkId, period);

    if (results.length === 0) {
      return {
        total: 0,
        success: 0,
        failed: 0,
        degraded: 0,
        avgResponseTime: 0,
        p95ResponseTime: 0,
      };
    }

    const success = results.filter((r) => r.status === "success").length;
    const failed = results.filter((r) => r.status === "failed").length;
    const degraded = results.filter((r) => r.status === "degraded").length;

    const responseTimes = results.map((r) => r.responseTime);
    const avgResponseTime = responseTimes.reduce((a, b) => a + b, 0) / responseTimes.length;

    const sorted = [...responseTimes].sort((a, b) => a - b);
    const p95Index = Math.floor(sorted.length * 0.95);
    const p95ResponseTime = sorted[p95Index] || 0;

    return {
      total: results.length,
      success,
      failed,
      degraded,
      avgResponseTime,
      p95ResponseTime,
    };
  }

  // ─── Clear Results ──────────────────────────────────────────────────────

  clearResults(checkId?: string): void {
    if (checkId) {
      this.results.delete(checkId);
    } else {
      this.results.clear();
    }
  }

  // ─── Get All Check IDs ──────────────────────────────────────────────────

  getAllCheckIds(): string[] {
    return Array.from(this.results.keys());
  }

  // ─── Get Availability by Location ───────────────────────────────────────

  getAvailabilityByLocation(
    checkId: string,
    period?: { start: string; end: string }
  ): Record<string, { availability: number; count: number }> {
    const results = this.getResults(checkId, period);
    
    const byLocation = new Map<string, { success: number; total: number }>();

    for (const result of results) {
      const locData = byLocation.get(result.location) || { success: 0, total: 0 };
      locData.total++;
      if (result.status === "success") {
        locData.success++;
      }
      byLocation.set(result.location, locData);
    }

    const result: Record<string, { availability: number; count: number }> = {};

    for (const [location, data] of byLocation) {
      result[location] = {
        availability: data.total > 0 ? data.success / data.total : 0,
        count: data.total,
      };
    }

    return result;
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Storage Interface (for alternative implementations)
// ─────────────────────────────────────────────────────────────────────────────

export interface StoreOptions {
  maxResultsPerCheck?: number;
  maxAgeHours?: number;
  databaseUrl?: string;
}

export interface StorageBackend {
  store(result: CheckResult): Promise<void>;
  getResults(
    checkId: string,
    period?: { start: string; end: string }
  ): Promise<CheckResult[]>;
  getStats(
    checkId: string,
    period?: { start: string; end: string }
  ): Promise<{
    total: number;
    success: number;
    failed: number;
    avgResponseTime: number;
    p95ResponseTime: number;
  }>;
}

// ─────────────────────────────────────────────────────────────────────────────
// Logger
// ─────────────────────────────────────────────────────────────────────────────

const log = createLogger("utils:synthetic-store", process.env.LOG_LEVEL ?? "info");