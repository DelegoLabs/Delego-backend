import { beforeEach, describe, expect, it } from "vitest";
import { getRateLimitMetrics, recordRateLimitOutcome, resetRateLimitMetrics } from "./metrics.js";

describe("rate limit metrics", () => {
  beforeEach(() => {
    resetRateLimitMetrics();
  });

  it("starts at zero with no denied keys", () => {
    const metrics = getRateLimitMetrics();
    expect(metrics).toEqual({
      totalRequests: 0,
      allowedRequests: 0,
      deniedRequests: 0,
      currentUtilization: 0,
      topDeniedKeys: [],
    });
  });

  it("tallies allowed and denied requests separately", () => {
    recordRateLimitOutcome("a", true);
    recordRateLimitOutcome("a", true);
    recordRateLimitOutcome("b", false);

    const metrics = getRateLimitMetrics();
    expect(metrics.totalRequests).toBe(3);
    expect(metrics.allowedRequests).toBe(2);
    expect(metrics.deniedRequests).toBe(1);
    expect(metrics.currentUtilization).toBeCloseTo(1 / 3, 5);
  });

  it("ranks topDeniedKeys by denial count, descending", () => {
    recordRateLimitOutcome("hot-key", false);
    recordRateLimitOutcome("hot-key", false);
    recordRateLimitOutcome("hot-key", false);
    recordRateLimitOutcome("warm-key", false);
    recordRateLimitOutcome("cold-key", false);

    const metrics = getRateLimitMetrics(2);
    expect(metrics.topDeniedKeys).toEqual([
      { key: "hot-key", count: 3 },
      { key: "warm-key", count: 1 },
    ]);
  });

  it("reset clears all counters", () => {
    recordRateLimitOutcome("a", false);
    resetRateLimitMetrics();
    expect(getRateLimitMetrics().totalRequests).toBe(0);
  });
});
