/**
 * Unit tests for #150 — webhook circuit breaker.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import {
  InMemoryCircuitBreakerStore,
  recordSuccess,
  recordFailure,
  getState,
  executeWithCircuitBreaker,
  CircuitBreakerOpenError,
  performAction,
  deliverWithFallback,
  type WebhookCircuitBreakerConfig,
} from "./webhookCircuitBreaker.js";

// ─── Fixtures ─────────────────────────────────────────────────────────────────

function makeConfig(overrides: Partial<WebhookCircuitBreakerConfig> = {}): WebhookCircuitBreakerConfig {
  return {
    failureThreshold: 3,
    successThreshold: 2,
    timeoutMs: 100,
    halfOpenRequests: 2,
    ...overrides,
  };
}

// ─── Tests ────────────────────────────────────────────────────────────────────

describe("webhook circuit breaker", () => {
  let store: InMemoryCircuitBreakerStore;

  beforeEach(() => {
    store = new InMemoryCircuitBreakerStore();
  });

  describe("recordFailure", () => {
    it("stays closed below failure threshold", async () => {
      const breaker = await recordFailure(store, "wh-1");
      expect(breaker.state).toBe("closed");
      expect(breaker.failureCount).toBe(1);
    });

    it("opens circuit when failure threshold is reached", async () => {
      for (let i = 0; i < 3; i++) {
        await recordFailure(store, "wh-1");
      }
      const breaker = (await store.get("wh-1"))!;
      expect(breaker.state).toBe("open");
      expect(breaker.failureCount).toBe(3);
      expect(breaker.nextAttemptAt).toBeDefined();
    });

    it("re-opens from half_open on failure", async () => {
      const cfg = makeConfig({ failureThreshold: 2, timeoutMs: 1 });
      // Open the circuit
      await recordFailure(store, "wh-1");
      await recordFailure(store, "wh-1");
      // Wait for cooldown
      await new Promise((r) => setTimeout(r, 5));
      // Transition to half_open
      await getState(store, "wh-1");
      // Fail in half_open
      await recordFailure(store, "wh-1", "still broken");
      const breaker = (await store.get("wh-1"))!;
      expect(breaker.state).toBe("open");
    });
  });

  describe("recordSuccess", () => {
    it("resets failure count in closed state", async () => {
      await recordFailure(store, "wh-1");
      await recordFailure(store, "wh-1");
      const breaker = await recordSuccess(store, "wh-1");
      expect(breaker.failureCount).toBe(0);
      expect(breaker.state).toBe("closed");
    });

    it("closes circuit after success threshold in half_open", async () => {
      const cfg = makeConfig({ failureThreshold: 1, successThreshold: 2 });
      // Open circuit
      await recordFailure(store, "wh-1");
      const b = (await store.get("wh-1"))!;
      expect(b.state).toBe("open");

      // Wait for cooldown
      await new Promise((r) => setTimeout(r, 5));

      // Force into half_open
      await getState(store, "wh-1");

      // Record enough successes to close
      await recordSuccess(store, "wh-1");
      const finalBreaker = await recordSuccess(store, "wh-1");
      expect(finalBreaker.state).toBe("closed");
      expect(finalBreaker.failureCount).toBe(0);
    });
  });

  describe("getState", () => {
    it("returns closed for new webhook", async () => {
      const state = await getState(store, "wh-new");
      expect(state).toBe("closed");
    });

    it("transitions open → half_open after cooldown", async () => {
      await recordFailure(store, "wh-1");
      await recordFailure(store, "wh-1");
      await recordFailure(store, "wh-1");
      // Open
      let state = await getState(store, "wh-1");
      expect(state).toBe("open");

      // Wait for cooldown
      await new Promise((r) => setTimeout(r, 5));
      state = await getState(store, "wh-1");
      expect(state).toBe("half_open");
    });
  });

  describe("executeWithCircuitBreaker", () => {
    it("executes function when circuit is closed", async () => {
      const result = await executeWithCircuitBreaker(store, "wh-1", async () => 42);
      expect(result).toBe(42);
    });

    it("throws CircuitBreakerOpenError when circuit is open", async () => {
      for (let i = 0; i < 3; i++) {
        await recordFailure(store, "wh-1");
      }
      await expect(
        executeWithCircuitBreaker(store, "wh-1", async () => "ok")
      ).rejects.toThrow(CircuitBreakerOpenError);
    });

    it("records success and failure automatically", async () => {
      await executeWithCircuitBreaker(store, "wh-1", async () => "ok");
      const breaker = (await store.get("wh-1"))!;
      expect(breaker.failureCount).toBe(0);

      await expect(
        executeWithCircuitBreaker(store, "wh-2", async () => {
          throw new Error("boom");
        })
      ).rejects.toThrow("boom");
      const b2 = (await store.get("wh-2"))!;
      expect(b2.failureCount).toBe(1);
    });
  });

  describe("performAction", () => {
    it("force_open opens the circuit", async () => {
      await performAction(store, {
        webhookId: "wh-1",
        action: "force_open",
        reason: "manual test",
        performedBy: "admin",
      });
      const breaker = (await store.get("wh-1"))!;
      expect(breaker.state).toBe("open");
    });

    it("force_closed resets the circuit", async () => {
      for (let i = 0; i < 3; i++) {
        await recordFailure(store, "wh-1");
      }
      await performAction(store, {
        webhookId: "wh-1",
        action: "reset",
        reason: "recovery",
        performedBy: "admin",
      });
      const breaker = (await store.get("wh-1"))!;
      expect(breaker.state).toBe("closed");
      expect(breaker.failureCount).toBe(0);
    });
  });

  describe("deliverWithFallback", () => {
    it("returns first successful channel", async () => {
      const deliverFn = vi.fn().mockResolvedValue(undefined);
      const channel = await deliverWithFallback(
        { fallbackChannels: ["in_app", "email"] },
        deliverFn
      );
      expect(channel).toBe("in_app");
      expect(deliverFn).toHaveBeenCalledTimes(1);
      expect(deliverFn).toHaveBeenCalledWith("in_app");
    });

    it("skips failed channels and tries next", async () => {
      const deliverFn = vi.fn()
        .mockRejectedValueOnce(new Error("sms failed"))
        .mockResolvedValue(undefined);
      const channel = await deliverWithFallback(
        { fallbackChannels: ["sms", "email"] },
        deliverFn
      );
      expect(channel).toBe("email");
      expect(deliverFn).toHaveBeenCalledTimes(2);
    });

    it("throws when all fallback channels fail", async () => {
      const deliverFn = vi.fn().mockRejectedValue(new Error("fail"));
      await expect(
        deliverWithFallback(
          { fallbackChannels: ["sms", "email"] },
          deliverFn
        )
      ).rejects.toThrow("All fallback delivery channels failed");
    });
  });
});
