/**
 * Tests for Status Page Integration
 */

import { describe, it, expect, beforeEach, vi } from "vitest";
import { StatusPageIntegration } from "./statusPage.js";

// Mock fetch
global.fetch = vi.fn();

describe("StatusPageIntegration", () => {
  let statusPage: StatusPageIntegration;

  beforeEach(() => {
    statusPage = new StatusPageIntegration({
      pageId: "test-page",
      apiKey: "test-api-key",
    });
  });

  describe("Check Registration", () => {
    it("should register check", () => {
      const check = {
        id: "test-check",
        name: "Test Check",
        type: "http",
        frequency: 60,
        locations: ["us-east-1"],
        request: {
          url: "https://example.com",
          method: "GET",
          headers: {},
        },
        assertions: [{ type: "status_code", operator: "eq", value: "200" }],
        alerting: { enabled: true, threshold: 3, notifyOnRecovery: true },
      };

      statusPage.registerCheck(check);

      const status = statusPage.getCheckStatus("test-check");
      expect(status).toBeNull(); // No status yet
    });
  });

  describe("Status Update", () => {
    it("should update status for healthy check", async () => {
      vi.mocked(fetch).mockResolvedValue({
        ok: true,
        status: 200,
        json: async () => ({}),
      } as any);

      const results = [
        {
          checkId: "test-check",
          location: "us-east-1",
          timestamp: new Date().toISOString(),
          status: "success",
          responseTime: 50,
          statusCode: 200,
          assertions: [{ passed: true, actual: "200", expected: "200" }],
        },
      ];

      await statusPage.updateStatus("test-check", results);

      const status = statusPage.getCheckStatus("test-check");
      expect(status).toBe("operational");
    });

    it("should update status for degraded check", async () => {
      vi.mocked(fetch).mockResolvedValue({
        ok: true,
        status: 200,
        json: async () => ({}),
      } as any);

      const results = [
        {
          checkId: "test-check",
          location: "us-east-1",
          timestamp: new Date().toISOString(),
          status: "success",
          responseTime: 50,
          statusCode: 200,
          assertions: [{ passed: true, actual: "200", expected: "200" }],
        },
        {
          checkId: "test-check",
          location: "us-east-1",
          timestamp: new Date().toISOString(),
          status: "failed",
          responseTime: 200,
          statusCode: 500,
          assertions: [{ passed: false, actual: "500", expected: "200" }],
        },
      ];

      await statusPage.updateStatus("test-check", results);

      const status = statusPage.getCheckStatus("test-check");
      expect(status).toBe("degraded_performance");
    });

    it("should update status for outage", async () => {
      vi.mocked(fetch).mockResolvedValue({
        ok: true,
        status: 200,
        json: async () => ({}),
      } as any);

      const results = [
        {
          checkId: "test-check",
          location: "us-east-1",
          timestamp: new Date().toISOString(),
          status: "failed",
          responseTime: 200,
          statusCode: 500,
          assertions: [{ passed: false, actual: "500", expected: "200" }],
        },
        {
          checkId: "test-check",
          location: "us-east-1",
          timestamp: new Date().toISOString(),
          status: "failed",
          responseTime: 200,
          statusCode: 500,
          assertions: [{ passed: false, actual: "500", expected: "200" }],
        },
      ];

      await statusPage.updateStatus("test-check", results);

      const status = statusPage.getCheckStatus("test-check");
      expect(status).toBe("major_outage");
    });
  });

  describe("Incident Management", () => {
    it("should create incident", async () => {
      vi.mocked(fetch).mockResolvedValue({
        ok: true,
        status: 201,
        json: async () => ({ id: "incident-1" }),
      } as any);

      await statusPage.createIncident(
        "test-check",
        "Service Degradation",
        "investigating",
        "We are investigating high response times"
      );

      expect(fetch).toHaveBeenCalledWith(
        "https://api.statuspage.io/v1/pages/test-page/incidents",
        expect.anything()
      );
    });

    it("should resolve incident", async () => {
      vi.mocked(fetch).mockResolvedValue({
        ok: true,
        status: 200,
        json: async () => ({}),
      } as any);

      await statusPage.resolveIncident("incident-1");

      expect(fetch).toHaveBeenCalledWith(
        "https://api.statuspage.io/v1/pages/test-page/incidents/incident-1",
        expect.anything()
      );
    });
  });

  describe("Status Page Integration", () => {
    it("should update all statuses", async () => {
      const check = {
        id: "test-check",
        name: "Test Check",
        type: "http",
        frequency: 60,
        locations: ["us-east-1"],
        request: {
          url: "https://example.com",
          method: "GET",
          headers: {},
        },
        assertions: [{ type: "status_code", operator: "eq", value: "200" }],
        alerting: { enabled: true, threshold: 3, notifyOnRecovery: true },
      };

      statusPage.registerCheck(check);

      vi.mocked(fetch).mockResolvedValue({
        ok: true,
        status: 200,
        json: async () => ({}),
      } as any);

      await statusPage.updateAllStatuses();

      expect(statusPage.getStatus().size).toBeGreaterThan(0);
    });
  });

  describe("Error Handling", () => {
    it("should handle API errors gracefully", async () => {
      vi.mocked(fetch).mockResolvedValue({
        ok: false,
        status: 401,
        statusText: "Unauthorized",
      } as any);

      const results = [
        {
          checkId: "test-check",
          location: "us-east-1",
          timestamp: new Date().toISOString(),
          status: "success",
          responseTime: 50,
          statusCode: 200,
          assertions: [{ passed: true, actual: "200", expected: "200" }],
        },
      ];

      // Should not throw error
      await expect(statusPage.updateStatus("test-check", results)).resolves.not.toThrow();
    });
  });
});