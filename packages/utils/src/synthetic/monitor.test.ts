/**
 * Tests for Synthetic Monitor
 */

import { describe, it, expect, beforeEach, vi, afterEach } from "vitest";
import { SyntheticMonitor } from "./monitor.js";
import { CheckExecutor } from "./executor.js";
import { CheckResultStore } from "./store.js";
import { CheckScheduler } from "./scheduler.js";

// Mock dependencies
vi.mock("./executor.js");
vi.mock("./store.js");
vi.mock("./scheduler.js");

describe("SyntheticMonitor", () => {
  let monitor: SyntheticMonitor;

  beforeEach(() => {
    // Reset mocks
    vi.clearAllMocks();
    monitor = new SyntheticMonitor();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe("Check Configuration", () => {
    it("should add check", () => {
      const check = {
        id: "test-check",
        name: "Test Check",
        type: "http" as const,
        frequency: 60,
        locations: ["us-east-1"],
        request: { url: "https://example.com", method: "GET", headers: {} },
        assertions: [{ type: "status_code", operator: "eq", value: "200" }],
        alerting: { enabled: true, threshold: 3, notifyOnRecovery: true },
      };

      monitor.addCheck(check);

      const retrieved = monitor.getCheck("test-check");
      expect(retrieved).toBeDefined();
      expect(retrieved?.name).toBe("Test Check");
    });

    it("should list all checks", () => {
      const checks = monitor.listChecks();
      
      expect(checks.length).toBeGreaterThan(0);
      expect(checks[0]).toHaveProperty("id");
      expect(checks[0]).toHaveProperty("name");
    });

    it("should remove check", () => {
      const check = {
        id: "remove-me",
        name: "Remove Me",
        type: "http" as const,
        frequency: 60,
        locations: ["us-east-1"],
        request: { url: "https://example.com", method: "GET", headers: {} },
        assertions: [{ type: "status_code", operator: "eq", value: "200" }],
        alerting: { enabled: true, threshold: 3, notifyOnRecovery: true },
      };

      monitor.addCheck(check);
      const removed = monitor.removeCheck("remove-me");

      expect(removed).toBe(true);
      expect(monitor.getCheck("remove-me")).toBeUndefined();
    });
  });

  describe("Check Execution", () => {
    it("should execute check", async () => {
      const mockResult = {
        checkId: "gateway-health",
        location: "us-east-1",
        timestamp: new Date().toISOString(),
        status: "success" as const,
        responseTime: 50,
        statusCode: 200,
        assertions: [{ passed: true, actual: "200", expected: "200" }],
      };

      vi.spyOn(monitor["executor"], "execute").mockResolvedValueOnce(mockResult);
      vi.spyOn(monitor["store"], "storeResult").mockResolvedValueOnce();

      const results = await monitor.runCheck("gateway-health", "us-east-1");

      expect(results.length).toBe(1);
      expect(results[0].status).toBe("success");
    });

    it("should skip check during maintenance", async () => {
      const mockResult = {
        checkId: "gateway-health",
        location: "us-east-1",
        timestamp: new Date().toISOString(),
        status: "success" as const,
        responseTime: 50,
        statusCode: 200,
        assertions: [{ passed: true, actual: "200", expected: "200" }],
      };

      vi.spyOn(monitor["executor"], "execute").mockResolvedValueOnce(mockResult);
      vi.spyOn(monitor["store"], "storeResult").mockResolvedValueOnce();

      // Mock maintenance window
      const isCheckActive = vi.spyOn(monitor["maintenanceManager"], "isCheckActive");
      isCheckActive.mockReturnValue(false);

      const results = await monitor.runCheck("gateway-health", "us-east-1");

      expect(results.length).toBe(0);
      expect(isCheckActive).toHaveBeenCalledWith("gateway-health");
    });

    it("should throw error for non-existent check", async () => {
      await expect(monitor.runCheck("nonexistent", "us-east-1")).rejects.toThrow("Check not found");
    });
  });

  describe("Metrics Generation", () => {
    it("should generate metrics for check", () => {
      const mockResults = [
        {
          checkId: "test-check",
          location: "us-east-1",
          timestamp: new Date().toISOString(),
          status: "success" as const,
          responseTime: 50,
        },
        {
          checkId: "test-check",
          location: "us-east-1",
          timestamp: new Date().toISOString(),
          status: "success" as const,
          responseTime: 100,
        },
        {
          checkId: "test-check",
          location: "us-east-1",
          timestamp: new Date().toISOString(),
          status: "failed" as const,
          responseTime: 200,
        },
      ];

      vi.spyOn(monitor["store"], "getResults").mockReturnValue(mockResults as any);

      const metrics = monitor.generateMetrics("test-check", {
        start: new Date(Date.now() - 3600000).toISOString(),
        end: new Date().toISOString(),
      });

      expect(metrics.checkId).toBe("test-check");
      expect(metrics.availability).toBeCloseTo(2 / 3);
      expect(metrics.avgResponseTime).toBeCloseTo(116.67, 0);
    });
  });

  describe("Incident Management", () => {
    it("should track incidents", () => {
      const mockResults = [
        {
          checkId: "test-check",
          location: "us-east-1",
          timestamp: new Date().toISOString(),
          status: "failed" as const,
          responseTime: 200,
        },
        {
          checkId: "test-check",
          location: "us-east-1",
          timestamp: new Date().toISOString(),
          status: "failed" as const,
          responseTime: 200,
        },
        {
          checkId: "test-check",
          location: "us-east-1",
          timestamp: new Date().toISOString(),
          status: "failed" as const,
          responseTime: 200,
        },
      ];

      // Add incidents
      monitor["incidents"].set("test-check", [{
        id: "incident_1",
        checkId: "test-check",
        location: "us-east-1",
        startTime: new Date().toISOString(),
        failureCount: 3,
        status: "active",
      }]);

      const incidents = monitor.getIncidents("test-check");

      expect(incidents.length).toBeGreaterThan(0);
      expect(incidents[0].status).toBe("active");
    });
  });

  describe("Benchmarks", () => {
    it("should get benchmarks", () => {
      const benchmarks = monitor.getBenchmarks("gateway-health", "1h");

      expect(benchmarks).toBeNull(); // No data yet
    });
  });

  describe("Status Page Integration", () => {
    it("should update status page", async () => {
      const mockStatusPage = {
        updateStatus: vi.fn().mockResolvedValue(undefined),
        updateAllStatuses: vi.fn().mockResolvedValue(undefined),
      };

      const statusPageMonitor = new SyntheticMonitor({
        statusPage: mockStatusPage as any,
      });

      await statusPageMonitor.updateStatusPage();

      expect(mockStatusPage.updateAllStatuses).toHaveBeenCalled();
    });
  });
});