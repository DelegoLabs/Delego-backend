import { describe, it, expect, beforeEach } from "vitest";
import { QueryPerformanceMonitor } from "./queryPerformance.js";

describe("Issue #153 — QueryPerformanceMonitor", () => {
  let monitor: QueryPerformanceMonitor;

  beforeEach(() => {
    monitor = new QueryPerformanceMonitor({
      slowQueryThresholdMs: 150,
      alertThresholds: {
        p95LatencyMs: 300,
        callsPerSecond: 500,
        errorRate: 0.05,
      },
    });
  });

  it("normalizes queries into consistent fingerprints", () => {
    const q1 = "SELECT * FROM users WHERE id = '123' AND status = 1";
    const q2 = "SELECT *   FROM   users WHERE id = '456' AND status = 2";

    const fp1 = QueryPerformanceMonitor.fingerprint(q1);
    const fp2 = QueryPerformanceMonitor.fingerprint(q2);

    expect(fp1).toBe(fp2);
    expect(fp1).toHaveLength(16);
  });

  it("detects slow queries exceeding threshold and raises alerts", () => {
    monitor.recordExecution("SELECT * FROM delegations WHERE user_id = 'user-1'", 50);
    expect(monitor.getSlowQueries()).toHaveLength(0);
    expect(monitor.getAlerts()).toHaveLength(0);

    monitor.recordExecution("SELECT * FROM transactions WHERE amount > 1000", 250);
    const slow = monitor.getSlowQueries();
    expect(slow).toHaveLength(1);
    expect(slow[0].avgTimeMs).toBe(250);

    const alerts = monitor.getAlerts();
    expect(alerts.length).toBeGreaterThanOrEqual(1);
    expect(alerts[0].type).toBe("slow_query");
    expect(alerts[0].value).toBe(250);
  });

  it("recommends indexes for high-latency unindexed queries", () => {
    const query = "SELECT * FROM accounts WHERE tenant_id = 'tenant-a' AND created_at >= '2026-01-01'";
    for (let i = 0; i < 5; i++) {
      monitor.recordExecution(query, 350);
    }

    const recommendations = monitor.recommendIndexes();
    expect(recommendations.length).toBeGreaterThanOrEqual(1);
    expect(recommendations[0].tableName).toBe("accounts");
    expect(recommendations[0].columns).toContain("tenant_id");
    expect(recommendations[0].createSQL).toContain("CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_accounts_");
  });

  it("caches and retrieves query execution plans", () => {
    const query = "SELECT * FROM audit_logs WHERE id = 'log-1'";
    const plan = { Node_Type: "Seq Scan", Relation_Name: "audit_logs", Total_Cost: 150.5 };

    monitor.recordExecution(query, 80, 1, 100, plan);
    const fp = QueryPerformanceMonitor.fingerprint(query);
    expect(monitor.getQueryPlan(fp)).toEqual(plan);
  });
});
