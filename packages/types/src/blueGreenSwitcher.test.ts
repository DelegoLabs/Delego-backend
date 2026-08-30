import { describe, it, expect, vi } from "vitest";
import { switchTraffic, rollback } from "./blueGreenSwitcher.js";
import type { BlueGreenConfig } from "./blueGreenDeployment.js";

function buildConfig(): BlueGreenConfig {
  return {
    namespace: "delego",
    blueDeployment: "gateway-blue",
    greenDeployment: "gateway-green",
    service: "gateway",
    ingress: "gateway-ingress",
    healthCheckPath: "/health",
    healthCheckIntervalSeconds: 5,
    healthCheckTimeoutSeconds: 2,
    switchTimeoutSeconds: 30,
  };
}

describe("switchTraffic — successful switch", () => {
  it("switches traffic to the target color after the required consecutive healthy checks", async () => {
    const checkHealth = vi.fn().mockResolvedValue(true);
    const applyTrafficSplit = vi.fn().mockResolvedValue(undefined);

    const result = await switchTraffic({
      config: buildConfig(),
      fromColor: "blue",
      toColor: "green",
      version: "v2.0.0",
      checkHealth,
      applyTrafficSplit,
    });

    expect(result.success).toBe(true);
    expect(result.rollbackTriggered).toBe(false);
    expect(checkHealth).toHaveBeenCalledTimes(3); // default requiredConsecutiveHealthyChecks
    expect(applyTrafficSplit).toHaveBeenCalledWith({ blue: 0, green: 100 });
  });

  it("switches to blue when toColor is blue", async () => {
    const applyTrafficSplit = vi.fn().mockResolvedValue(undefined);
    await switchTraffic({
      config: buildConfig(),
      fromColor: "green",
      toColor: "blue",
      version: "v2.0.0",
      checkHealth: vi.fn().mockResolvedValue(true),
      applyTrafficSplit,
      requiredConsecutiveHealthyChecks: 1,
    });
    expect(applyTrafficSplit).toHaveBeenCalledWith({ blue: 100, green: 0 });
  });

  it("respects a custom requiredConsecutiveHealthyChecks", async () => {
    const checkHealth = vi.fn().mockResolvedValue(true);
    await switchTraffic({
      config: buildConfig(),
      fromColor: "blue",
      toColor: "green",
      version: "v2.0.0",
      checkHealth,
      applyTrafficSplit: vi.fn().mockResolvedValue(undefined),
      requiredConsecutiveHealthyChecks: 5,
    });
    expect(checkHealth).toHaveBeenCalledTimes(5);
  });
});

describe("switchTraffic — failed health checks trigger no-op rollback", () => {
  it("never applies a traffic split when a health check fails", async () => {
    const checkHealth = vi.fn().mockResolvedValue(false);
    const applyTrafficSplit = vi.fn().mockResolvedValue(undefined);

    const result = await switchTraffic({
      config: buildConfig(),
      fromColor: "blue",
      toColor: "green",
      version: "v2.0.0",
      checkHealth,
      applyTrafficSplit,
    });

    expect(result.success).toBe(false);
    expect(result.rollbackTriggered).toBe(true);
    expect(result.healthChecksPassed).toBe(false);
    expect(applyTrafficSplit).not.toHaveBeenCalled();
  });

  it("resets the healthy-check count on a single failure mid-sequence (requires a clean run)", async () => {
    const checkHealth = vi
      .fn()
      .mockResolvedValueOnce(true)
      .mockResolvedValueOnce(true)
      .mockResolvedValueOnce(false); // fails on what would be the 3rd check

    const result = await switchTraffic({
      config: buildConfig(),
      fromColor: "blue",
      toColor: "green",
      version: "v2.0.0",
      checkHealth,
      applyTrafficSplit: vi.fn().mockResolvedValue(undefined),
    });

    expect(result.success).toBe(false);
    expect(checkHealth).toHaveBeenCalledTimes(3);
  });
});

describe("switchTraffic — timing", () => {
  it("reports a non-negative durationMs using the injected clock", async () => {
    let tick = 1000;
    const now = () => (tick += 100);

    const result = await switchTraffic({
      config: buildConfig(),
      fromColor: "blue",
      toColor: "green",
      version: "v2.0.0",
      checkHealth: vi.fn().mockResolvedValue(true),
      applyTrafficSplit: vi.fn().mockResolvedValue(undefined),
      requiredConsecutiveHealthyChecks: 1,
      now,
    });

    expect(result.durationMs).toBeGreaterThanOrEqual(0);
  });
});

describe("rollback", () => {
  it("reapplies the fromColor's full traffic split", async () => {
    const applyTrafficSplit = vi.fn().mockResolvedValue(undefined);
    await rollback("blue", applyTrafficSplit);
    expect(applyTrafficSplit).toHaveBeenCalledWith({ blue: 100, green: 0 });
  });

  it("reapplies green's full traffic split when rolling back to green", async () => {
    const applyTrafficSplit = vi.fn().mockResolvedValue(undefined);
    await rollback("green", applyTrafficSplit);
    expect(applyTrafficSplit).toHaveBeenCalledWith({ blue: 0, green: 100 });
  });
});
