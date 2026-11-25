import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { HSMKeySignerAdapter } from "./hsmSigner.js";
import {
  checkHSMHealth,
  clearCircuitBreakers,
  clearHSMAuditTrail,
  clearHSMHealthState,
  getHSMAuditTrail,
  getHSMHealthStatus,
  isHSMAvailable,
  recordHSMAudit,
} from "./hsmHealth.js";

function createMockAdapter(
  getPublicKeyImpl: (keyId: string) => Promise<string>
): HSMKeySignerAdapter {
  return {
    sign: vi.fn(async () => Buffer.alloc(64)),
    getPublicKey: vi.fn(getPublicKeyImpl),
  };
}

describe("hsmHealth", () => {
  beforeEach(() => {
    clearHSMHealthState();
    vi.useRealTimers();
  });

  afterEach(() => {
    clearHSMHealthState();
    vi.useRealTimers();
  });

  describe("checkHSMHealth and getHSMHealthStatus", () => {
    it("returns null status before any health check has been recorded", () => {
      expect(getHSMHealthStatus("unknown-key")).toBeNull();
      expect(isHSMAvailable("unknown-key")).toBe(true);
    });

    it("reports healthy state when the probe succeeds", async () => {
      const adapter = createMockAdapter(async () => "GPUBLICKEY");

      const result = await checkHSMHealth(adapter, "key-healthy");

      expect(result.status).toBe("healthy");
      expect(result.consecutiveFailures).toBe(0);
      expect(result.uptime).toBe(100);
      expect(result.lastError).toBeUndefined();
      expect(result.latencyMs).toBeGreaterThanOrEqual(0);
      expect(isHSMAvailable("key-healthy")).toBe(true);

      const snapshot = getHSMHealthStatus("key-healthy");
      expect(snapshot).not.toBeNull();
      expect(snapshot!.status).toBe("healthy");
      expect(snapshot!.uptime).toBe(100);
    });

    it("reports degraded state on transient failures below circuit breaker threshold", async () => {
      const adapter = createMockAdapter(async () => {
        throw new Error("HSM timeout");
      });

      const first = await checkHSMHealth(adapter, "key-degraded");

      expect(first.status).toBe("degraded");
      expect(first.consecutiveFailures).toBe(1);
      expect(first.lastError).toBe("HSM timeout");
      expect(first.uptime).toBe(0);
      expect(isHSMAvailable("key-degraded")).toBe(true);

      const snapshot = getHSMHealthStatus("key-degraded");
      expect(snapshot?.status).toBe("degraded");
      expect(snapshot?.lastError).toBe("HSM timeout");
    });

    it("transitions to unavailable and opens the circuit breaker after 5 consecutive failures", async () => {
      const adapter = createMockAdapter(async () => {
        throw new Error("HSM unreachable");
      });

      for (let i = 1; i <= 4; i++) {
        const res = await checkHSMHealth(adapter, "key-cb");
        expect(res.status).toBe("degraded");
        expect(res.consecutiveFailures).toBe(i);
        expect(isHSMAvailable("key-cb")).toBe(true);
      }

      const fifth = await checkHSMHealth(adapter, "key-cb");
      expect(fifth.status).toBe("unavailable");
      expect(fifth.consecutiveFailures).toBe(5);
      expect(isHSMAvailable("key-cb")).toBe(false);

      const snapshot = getHSMHealthStatus("key-cb");
      expect(snapshot?.status).toBe("unavailable");
    });

    it("transitions circuit breaker to half-open after cooldown and recovers on success", async () => {
      vi.useFakeTimers();
      vi.setSystemTime(new Date("2026-01-01T00:00:00.000Z"));

      let shouldFail = true;
      const adapter = createMockAdapter(async () => {
        if (shouldFail) throw new Error("HSM down");
        return "GPUBLICKEY";
      });

      for (let i = 0; i < 5; i++) {
        await checkHSMHealth(adapter, "key-recover");
      }
      expect(isHSMAvailable("key-recover")).toBe(false);

      // Advance past the 60s open duration
      vi.advanceTimersByTime(60_001);
      expect(isHSMAvailable("key-recover")).toBe(true);

      // Probe succeeds: consecutive failures reset, but uptime is 1/6 (< 95%) => degraded
      shouldFail = false;
      const recovered = await checkHSMHealth(adapter, "key-recover");
      expect(recovered.consecutiveFailures).toBe(0);
      expect(recovered.status).toBe("degraded");
      expect(recovered.uptime).toBeCloseTo((1 / 6) * 100, 5);
      expect(isHSMAvailable("key-recover")).toBe(true);
    });

    it("allows clearing circuit breakers independently", async () => {
      const adapter = createMockAdapter(async () => {
        throw new Error("HSM failure");
      });

      for (let i = 0; i < 5; i++) {
        await checkHSMHealth(adapter, "key-reset-cb");
      }
      expect(isHSMAvailable("key-reset-cb")).toBe(false);

      clearCircuitBreakers();
      expect(isHSMAvailable("key-reset-cb")).toBe(true);
    });
  });

  describe("HSM audit trail", () => {
    it("records and filters audit entries by keyId, operation, since, and limit", () => {
      vi.useFakeTimers();
      vi.setSystemTime(new Date("2026-01-01T10:00:00.000Z"));
      recordHSMAudit({
        operation: "sign",
        keyId: "key-1",
        success: true,
        latencyMs: 12,
      });

      vi.setSystemTime(new Date("2026-01-01T10:05:00.000Z"));
      recordHSMAudit({
        operation: "getPublicKey",
        keyId: "key-2",
        success: false,
        error: "denied",
        errorCode: "ACCESS_DENIED",
      });

      vi.setSystemTime(new Date("2026-01-01T10:10:00.000Z"));
      recordHSMAudit({
        operation: "sign",
        keyId: "key-1",
        success: true,
        latencyMs: 8,
      });

      expect(getHSMAuditTrail()).toHaveLength(3);
      expect(getHSMAuditTrail({ keyId: "key-1" })).toHaveLength(2);
      expect(getHSMAuditTrail({ operation: "getPublicKey" })).toHaveLength(1);
      expect(getHSMAuditTrail({ since: "2026-01-01T10:05:00.000Z" })).toHaveLength(2);
      expect(getHSMAuditTrail({ limit: 1 })).toHaveLength(1);
      expect(getHSMAuditTrail({ limit: 1 })[0].latencyMs).toBe(8);

      clearHSMAuditTrail();
      expect(getHSMAuditTrail()).toHaveLength(0);
    });
  });
});
