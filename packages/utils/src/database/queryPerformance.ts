/**
 * Issue #153 — Query performance monitoring with slow query detection,
 * fingerprinting, query plan analysis, and index recommendations.
 */

import { createHash } from "node:crypto";
import { createLogger } from "../logger.js";

const log = createLogger("utils:query-performance", process.env.LOG_LEVEL ?? "info");

export interface QueryPerformanceConfig {
  slowQueryThresholdMs: number;
  sampleRate: number;
  trackPlans: boolean;
  planRetentionDays: number;
  alertThresholds: {
    p95LatencyMs: number;
    callsPerSecond: number;
    errorRate: number;
  };
}

export interface SlowQuery {
  queryId: string;
  fingerprint: string;
  query: string;
  calls: number;
  totalTimeMs: number;
  avgTimeMs: number;
  minTimeMs: number;
  maxTimeMs: number;
  rowsReturned: number;
  hitPercent: number;
  plan?: Record<string, unknown>;
  firstSeen: string;
  lastSeen: string;
}

export interface IndexRecommendation {
  tableName: string;
  columns: string[];
  type: "btree" | "hash" | "gin" | "gist" | "brin";
  reason: string;
  estimatedBenefit: {
    queriesAffected: number;
    avgSpeedup: number;
    sizeIncreaseBytes: number;
  };
  createSQL: string;
}

export interface QueryAlert {
  type: "slow_query" | "p95_breach" | "error_rate_breach";
  fingerprint: string;
  message: string;
  value: number;
  threshold: number;
  timestamp: string;
}

export class QueryPerformanceMonitor {
  private readonly config: QueryPerformanceConfig;
  private readonly slowQueries = new Map<string, SlowQuery>();
  private readonly alerts: QueryAlert[] = [];
  private readonly planCache = new Map<string, { plan: Record<string, unknown>; cachedAt: number }>();

  constructor(config?: Partial<QueryPerformanceConfig>) {
    this.config = {
      slowQueryThresholdMs: config?.slowQueryThresholdMs ?? 200,
      sampleRate: config?.sampleRate ?? 1.0,
      trackPlans: config?.trackPlans ?? true,
      planRetentionDays: config?.planRetentionDays ?? 7,
      alertThresholds: {
        p95LatencyMs: config?.alertThresholds?.p95LatencyMs ?? 500,
        callsPerSecond: config?.alertThresholds?.callsPerSecond ?? 1000,
        errorRate: config?.alertThresholds?.errorRate ?? 0.05,
      },
    };
  }

  /**
   * Generates a normalized query fingerprint by stripping literals and whitespace.
   */
  static fingerprint(query: string): string {
    const normalized = query
      .replace(/\s+/g, " ")
      .replace(/'[^']*'/g, "?")
      .replace(/\b\d+\b/g, "?")
      .replace(/\$[0-9]+/g, "?")
      .trim()
      .toLowerCase();

    return createHash("sha256").update(normalized).digest("hex").slice(0, 16);
  }

  /**
   * Records a query execution and tracks slow queries.
   */
  recordExecution(
    query: string,
    durationMs: number,
    rowsReturned: number = 0,
    hitPercent: number = 100,
    plan?: Record<string, unknown>
  ): void {
    const fp = QueryPerformanceMonitor.fingerprint(query);
    const now = new Date().toISOString();

    let entry = this.slowQueries.get(fp);
    if (!entry) {
      entry = {
        queryId: `qid-${fp}`,
        fingerprint: fp,
        query,
        calls: 1,
        totalTimeMs: durationMs,
        avgTimeMs: durationMs,
        minTimeMs: durationMs,
        maxTimeMs: durationMs,
        rowsReturned,
        hitPercent,
        plan,
        firstSeen: now,
        lastSeen: now,
      };
      this.slowQueries.set(fp, entry);
    } else {
      entry.calls += 1;
      entry.totalTimeMs += durationMs;
      entry.avgTimeMs = entry.totalTimeMs / entry.calls;
      entry.minTimeMs = Math.min(entry.minTimeMs, durationMs);
      entry.maxTimeMs = Math.max(entry.maxTimeMs, durationMs);
      entry.rowsReturned += rowsReturned;
      entry.hitPercent = (entry.hitPercent + hitPercent) / 2;
      entry.lastSeen = now;
      if (plan) entry.plan = plan;
    }

    if (durationMs >= this.config.slowQueryThresholdMs) {
      log.warn("Slow query detected", { fingerprint: fp, durationMs, threshold: this.config.slowQueryThresholdMs });
      this.alerts.push({
        type: "slow_query",
        fingerprint: fp,
        message: `Query exceeded ${this.config.slowQueryThresholdMs}ms threshold: took ${durationMs}ms`,
        value: durationMs,
        threshold: this.config.slowQueryThresholdMs,
        timestamp: now,
      });
    }

    if (entry.avgTimeMs >= this.config.alertThresholds.p95LatencyMs) {
      this.alerts.push({
        type: "p95_breach",
        fingerprint: fp,
        message: `Query avg latency ${entry.avgTimeMs.toFixed(2)}ms breached SLA threshold ${this.config.alertThresholds.p95LatencyMs}ms`,
        value: entry.avgTimeMs,
        threshold: this.config.alertThresholds.p95LatencyMs,
        timestamp: now,
      });
    }

    if (plan && this.config.trackPlans) {
      this.planCache.set(fp, { plan, cachedAt: Date.now() });
    }
  }

  /**
   * Generates index recommendations based on sequential scan detection and WHERE/JOIN columns.
   */
  recommendIndexes(): IndexRecommendation[] {
    const recommendations: IndexRecommendation[] = [];

    for (const [_, sq] of this.slowQueries) {
      // Analyze sequential scan patterns in query text
      const whereMatch = sq.query.match(/FROM\s+([a-zA-Z0-9_]+)\s+WHERE\s+([^;]+)/i);
      if (whereMatch && sq.avgTimeMs > 100) {
        const tableName = whereMatch[1];
        const whereClause = whereMatch[2];

        // Extract column names used in conditions
        const columnMatches = whereClause.match(/([a-zA-Z0-9_]+)\s*(?:=|IN|>=|<=|>|<|LIKE)/gi);
        if (columnMatches && columnMatches.length > 0) {
          const columns = [
            ...new Set(
              columnMatches.map((c) =>
                c.replace(/\s*(?:=|IN|>=|<=|>|<|LIKE)/i, "").trim()
              )
            ),
          ];

          const indexName = `idx_${tableName}_${columns.join("_")}`;
          const createSQL = `CREATE INDEX CONCURRENTLY IF NOT EXISTS ${indexName} ON ${tableName} USING btree (${columns.join(", ")});`;

          recommendations.push({
            tableName,
            columns,
            type: "btree",
            reason: `High average latency (${sq.avgTimeMs.toFixed(2)}ms across ${sq.calls} calls) filtering on columns: ${columns.join(", ")}`,
            estimatedBenefit: {
              queriesAffected: sq.calls,
              avgSpeedup: Math.min(10, Math.max(2, sq.avgTimeMs / 20)),
              sizeIncreaseBytes: columns.length * 1024 * 1024,
            },
            createSQL,
          });
        }
      }
    }

    return recommendations;
  }

  getSlowQueries(): SlowQuery[] {
    return [...this.slowQueries.values()].filter(
      (q) => q.avgTimeMs >= this.config.slowQueryThresholdMs
    );
  }

  getAlerts(): QueryAlert[] {
    return [...this.alerts];
  }

  getQueryPlan(fingerprint: string): Record<string, unknown> | undefined {
    return this.planCache.get(fingerprint)?.plan;
  }

  clear(): void {
    this.slowQueries.clear();
    this.alerts.length = 0;
    this.planCache.clear();
  }
}
