/**
 * Tests for SLI Registry
 */

import { describe, it, expect, beforeEach } from "vitest";
import { SLIRegistry } from "./sliRegistry.js";

describe("SLIRegistry", () => {
  let registry: SLIRegistry;

  beforeEach(() => {
    registry = new SLIRegistry();
  });

  describe("Default SLIs", () => {
    it("should register default availability SLIs", () => {
      const availabilitySLIs = registry.listSLIs().filter((sli) => 
        sli.name.includes("availability") || sli.name.includes("success_rate")
      );
      
      expect(availabilitySLIs.length).toBeGreaterThanOrEqual(5);
    });

    it("should register default latency SLIs", () => {
      const latencySLIs = registry.listSLIs().filter((sli) => 
        sli.name.includes("latency")
      );
      
      expect(latencySLIs.length).toBeGreaterThanOrEqual(3);
    });

    it("should register default throughput SLIs", () => {
      const throughputSLIs = registry.listSLIs().filter((sli) => 
        sli.name.includes("throughput")
      );
      
      expect(throughputSLIs.length).toBeGreaterThanOrEqual(2);
    });
  });

  describe("Register SLI", () => {
    it("should register custom SLI", () => {
      registry.registerSLI({
        name: "custom_sli",
        description: "Custom SLI",
        query: "1 - (sum(rate(errors[1h])) / sum(rate(total[1h])))",
        unit: "ratio",
        thresholds: { good: 0.999 },
      });

      const sli = registry.getSLI("custom_sli");
      expect(sli).toBeDefined();
      expect(sli?.name).toBe("custom_sli");
    });

    it("should return undefined for non-existent SLI", () => {
      const sli = registry.getSLI("nonexistent");
      expect(sli).toBeUndefined();
    });
  });

  describe("Get Service SLIs", () => {
    it("should return service-specific SLIs", () => {
      const gatewaySLIs = registry.getServiceSLIs("gateway");
      
      expect(gatewaySLIs.length).toBeGreaterThanOrEqual(3);
      expect(gatewaySLIs.some((sli) => sli.name.includes("availability"))).toBe(true);
    });
  });

  describe("Generate PromQL Query", () => {
    it("should generate PromQL query for SLI", () => {
      const query = registry.generatePromQLQuery("gateway_availability", "gateway", "rolling_24h");
      
      expect(query).toContain("http_requests_total");
      expect(query).toContain("status=~\"5..\"");
    });

    it("should replace time window in query", () => {
      const query1h = registry.generatePromQLQuery("gateway_availability", "gateway", "rolling_1h");
      const query24h = registry.generatePromQLQuery("gateway_availability", "gateway", "rolling_24h");
      
      expect(query1h).toContain("[1h]");
      expect(query24h).toContain("[24h]");
    });
  });

  describe("Evaluate SLI", () => {
    it("should pass SLI when value meets threshold", () => {
      const result = registry.evaluateSLI("gateway_availability", "gateway", 0.9995);
      
      expect(result.status).toBe("pass");
      expect(result.percentage).toBeGreaterThan(100);
    });

    it("should warn SLI when value is below good but above poor", () => {
      const result = registry.evaluateSLI("gateway_availability", "gateway", 0.995);
      
      expect(result.status).toBe("warning");
    });

    it("should fail SLI when value is below poor threshold", () => {
      const result = registry.evaluateSLI("gateway_availability", "gateway", 0.98);
      
      expect(result.status).toBe("fail");
    });

    it("should handle latency SLI (lower is better)", () => {
      const result = registry.evaluateSLI("gateway_p95_latency", "gateway", 0.15);
      
      expect(result.status).toBe("pass");
    });
  });
});