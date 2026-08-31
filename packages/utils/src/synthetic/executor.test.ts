/**
 * Tests for Check Executor
 */

import { describe, it, expect, beforeEach, vi } from "vitest";
import { CheckExecutor } from "./executor.js";

// Mock fetch for HTTP checks
global.fetch = vi.fn();

describe("CheckExecutor", () => {
  let executor: CheckExecutor;

  beforeEach(() => {
    executor = new CheckExecutor({
      locations: ["us-east-1", "us-west-2", "eu-west-1"],
    });
  });

  describe("HTTP Check", () => {
    it("should execute HTTP check successfully", async () => {
      const mockResponse = {
        status: 200,
        statusText: "OK",
        headers: new Map([
          ["content-type", "application/json"],
          ["content-length", "123"],
        ]),
        text: async () => JSON.stringify({ status: "ok" }),
        ok: true,
        redirected: false,
        url: "https://api.example.com/health",
        type: "basic",
        clone: function() { return this; },
        body: null,
        bodyUsed: false,
        arrayBuffer: async () => new ArrayBuffer(0),
        formData: async () => new FormData(),
        json: async () => ({ status: "ok" }),
      };

      vi.mocked(fetch).mockResolvedValueOnce(mockResponse as any);

      const check = {
        id: "http-check",
        name: "HTTP Check",
        type: "http",
        frequency: 60,
        locations: ["us-east-1"],
        request: {
          url: "https://api.example.com/health",
          method: "GET",
          headers: {},
        },
        assertions: [{ type: "status_code", operator: "eq", value: "200" }],
        alerting: { enabled: true, threshold: 3, notifyOnRecovery: true },
      };

      const result = await executor.execute(check, "us-east-1");

      expect(result.checkId).toBe("http-check");
      expect(result.statusCode).toBe(200);
      expect(result.status).toBe("success");
      expect(result.assertions[0].passed).toBe(true);
    });

    it("should handle HTTP check failure", async () => {
      vi.mocked(fetch).mockRejectedValueOnce(new Error("Network error"));

      const check = {
        id: "http-check",
        name: "HTTP Check",
        type: "http",
        frequency: 60,
        locations: ["us-east-1"],
        request: {
          url: "https://api.example.com/health",
          method: "GET",
          headers: {},
        },
        assertions: [{ type: "status_code", operator: "eq", value: "200" }],
        alerting: { enabled: true, threshold: 3, notifyOnRecovery: true },
      };

      const result = await executor.execute(check, "us-east-1");

      expect(result.status).toBe("failed");
      expect(result.error).toBeDefined();
    });
  });

  describe("DNS Check", () => {
    it("should execute DNS check successfully", async () => {
      const dns = require("dns");
      vi.spyOn(dns, "resolve4").mockImplementation((hostname, callback) => {
        callback(null, ["1.2.3.4"]);
      });

      const check = {
        id: "dns-check",
        name: "DNS Check",
        type: "dns",
        frequency: 300,
        locations: ["us-east-1"],
        request: {
          url: "https://api.example.com",
          method: "GET",
          headers: {},
        },
        assertions: [],
        alerting: { enabled: true, threshold: 3, notifyOnRecovery: true },
      };

      const result = await executor.execute(check, "us-east-1");

      expect(result.statusCode).toBe(200);
      expect(result.dnsInfo).toBeDefined();
      expect(result.dnsInfo?.ips).toContain("1.2.3.4");
    });

    it("should handle DNS lookup failure", async () => {
      const dns = require("dns");
      vi.spyOn(dns, "resolve4").mockImplementation((hostname, callback) => {
        callback(new Error("DNS error"), []);
      });

      const check = {
        id: "dns-check",
        name: "DNS Check",
        type: "dns",
        frequency: 300,
        locations: ["us-east-1"],
        request: {
          url: "https://api.example.com",
          method: "GET",
          headers: {},
        },
        assertions: [],
        alerting: { enabled: true, threshold: 3, notifyOnRecovery: true },
      };

      const result = await executor.execute(check, "us-east-1");

      expect(result.status).toBe("failed");
      expect(result.error).toContain("DNS check failed");
    });
  });

  describe("TCP Check", () => {
    it("should execute TCP check successfully", async () => {
      const net = require("net");
      vi.spyOn(net, "connect").mockImplementation(() => {
        return {
          on: (event: string, callback: () => void) => {
            if (event === "connect") {
              callback();
            }
          },
          destroy: () => {},
          setTimeout: () => {},
        };
      });

      const check = {
        id: "tcp-check",
        name: "TCP Check",
        type: "tcp",
        frequency: 60,
        locations: ["us-east-1"],
        request: {
          url: "tcp://api.example.com:443",
          method: "GET",
          headers: {},
        },
        assertions: [],
        alerting: { enabled: true, threshold: 3, notifyOnRecovery: true },
      };

      const result = await executor.execute(check, "us-east-1");

      expect(result.statusCode).toBe(200);
    });
  });

  describe("SSL Check", () => {
    it("should execute SSL check successfully", async () => {
      const https = require("https");
      vi.mocked(https.request).mockImplementation(() => {
        return {
          on: (event: string, callback: () => void) => {
            if (event === "socket") {
              callback({
                on: (evt: string, cb: () => void) => {
                  if (evt === "secureConnect") {
                    cb();
                  }
                },
              });
            } else if (event === "error") {
              callback(new Error("SSL error"));
            }
          },
          end: () => {},
        };
      });

      const check = {
        id: "ssl-check",
        name: "SSL Check",
        type: "ssl",
        frequency: 3600,
        locations: ["us-east-1"],
        request: {
          url: "https://api.example.com",
          method: "GET",
          headers: {},
        },
        assertions: [{ type: "certificate", operator: "eq", value: "valid" }],
        alerting: { enabled: true, threshold: 3, notifyOnRecovery: true },
      };

      const result = await executor.execute(check, "us-east-1");

      expect(result.statusCode).toBe(200);
      expect(result.sslInfo).toBeDefined();
      expect(result.sslInfo?.valid).toBe(true);
    });
  });

  describe("Assertion Validation", () => {
    it("should validate status code assertions", async () => {
      const assertion = {
        type: "status_code" as const,
        operator: "eq" as const,
        value: "200",
      };

      const result = {
        statusCode: 200,
        responseTime: 50,
      };

      const validator = (executor as any).validateAssertions([assertion], result);
      expect(validator[0].passed).toBe(true);
    });

    it("should validate response time assertions", async () => {
      const assertion = {
        type: "response_time" as const,
        operator: "lt" as const,
        value: "100",
      };

      const result = {
        statusCode: 200,
        responseTime: 50,
      };

      const validator = (executor as any).validateAssertions([assertion], result);
      expect(validator[0].passed).toBe(true);
    });

    it("should validate body contains assertions", async () => {
      const assertion = {
        type: "body_contains" as const,
        operator: "contains" as const,
        value: "ok",
      };

      const result = {
        statusCode: 200,
        responseTime: 50,
        body: '{"status":"ok"}',
      };

      const validator = (executor as any).validateAssertions([assertion], result);
      expect(validator[0].passed).toBe(true);
    });

    it("should validate json path assertions", async () => {
      const assertion = {
        type: "json_path" as const,
        operator: "contains" as const,
        value: "status",
      };

      const result = {
        statusCode: 200,
        responseTime: 50,
        body: '{"status":"ok"}',
      };

      const validator = (executor as any).validateAssertions([assertion], result);
      expect(validator[0].passed).toBe(true);
    });

    it("should validate header assertions", async () => {
      const assertion = {
        type: "header" as const,
        operator: "eq" as const,
        value: "content-type",
      };

      const result = {
        statusCode: 200,
        responseTime: 50,
        headers: { "content-type": "application/json" },
      };

      const validator = (executor as any).validateAssertions([assertion], result);
      expect(validator[0].passed).toBe(true);
    });
  });
});