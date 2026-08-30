/**
 * Tests for Check Result Store
 */

import { describe, it, expect, beforeEach } from "vitest";
import { CheckResultStore } from "./store.js";

describe("CheckResultStore", () => {
  let store: CheckResultStore;

  beforeEach(() => {
    store = new CheckResultStore();
  });

  describe("Store and Retrieve", () => {
    it("should store and retrieve results", async () => {
      const result = {
        checkId: "test-check",
        location: "us-east-1",
        timestamp: new Date().toISOString(),
        status: "success",
        responseTime: 50,
        statusCode: 200,
        assertions: [{ passed: true, actual: "200", expected: "200" }],
      };

      await store.storeResult(result);

      const results = store.getResults("test-check");
      expect(results.length).toBe(1);
      expect(results[0].status).toBe("success");
    });

    it("should trim old results", async () => {
      // Fill store with max results
      for (let i = 0; i < 100; i++) {
        await store.storeResult({
          checkId: "test-check",
          location: "us-east-1",
          timestamp: new Date(Date.now() - i * 1000).toISOString(),
          status: "success",
          responseTime: 50,
          statusCode: 200,
          assertions: [{ passed: true, actual: "200", expected: "200" }],
        });
      }

      // Add more results to trigger trim
      for (let i = 100; i < 1005; i++) {
        await store.storeResult({
          checkId: "test-check",
          location: "us-east-1",
          timestamp: new Date(Date.now() - i * 1000).toISOString(),
          status: "success",
          responseTime: 50,
          statusCode: 200,
          assertions: [{ passed: true, actual: "200", expected: "200" }],
        });
      }

      const results = store.getResults("test-check");
      expect(results.length).toBeLessThanOrEqual(1000);
    });

    it("should filter by time period", async () => {
      const now = Date.now();
      
      // Store results in different times
      await store.storeResult({
        checkId: "test-check",
        location: "us-east-1",
        timestamp: new Date(now - 3600000).toISOString(), // 1 hour ago
        status: "success",
        responseTime: 50,
        statusCode: 200,
        assertions: [{ passed: true, actual: "200", expected: "200" }],
      });

      await store.storeResult({
        checkId: "test-check",
        location: "us-east-1",
        timestamp: new Date(now - 1800000).toISOString(), // 30 min ago
        status: "success",
        responseTime: 50,
        statusCode: 200,
        assertions: [{ passed: true, actual: "200", expected: "200" }],
      });

      const results = store.getResults("test-check", {
        start: new Date(now - 2700000).toISOString(), // 45 min ago
        end: new Date(now).toISOString(),
      });

      // Should only return recent result
      expect(results.length).toBe(1);
    });
  });

  describe("Stats", () => {
    it("should calculate stats", async () => {
      await store.storeResult({
        checkId: "test-check",
        location: "us-east-1",
        timestamp: new Date().toISOString(),
        status: "success",
        responseTime: 50,
        statusCode: 200,
        assertions: [{ passed: true, actual: "200", expected: "200" }],
      });

      await store.storeResult({
        checkId: "test-check",
        location: "us-east-1",
        timestamp: new Date().toISOString(),
        status: "success",
        responseTime: 100,
        statusCode: 200,
        assertions: [{ passed: true, actual: "200", expected: "200" }],
      });

      await store.storeResult({
        checkId: "test-check",
        location: "us-east-1",
        timestamp: new Date().toISOString(),
        status: "failed",
        responseTime: 200,
        statusCode: 500,
        assertions: [{ passed: false, actual: "500", expected: "200" }],
      });

      const stats = store.getStats("test-check");

      expect(stats.total).toBe(3);
      expect(stats.success).toBe(2);
      expect(stats.failed).toBe(1);
      expect(stats.avgResponseTime).toBeCloseTo(116.67, 0);
    });

    it("should handle empty results", async () => {
      const stats = store.getStats("nonexistent");

      expect(stats.total).toBe(0);
      expect(stats.avgResponseTime).toBe(0);
    });
  });

  describe("Availability by Location", () => {
    it("should calculate availability by location", async () => {
      await store.storeResult({
        checkId: "test-check",
        location: "us-east-1",
        timestamp: new Date().toISOString(),
        status: "success",
        responseTime: 50,
        statusCode: 200,
        assertions: [{ passed: true, actual: "200", expected: "200" }],
      });

      await store.storeResult({
        checkId: "test-check",
        location: "us-east-1",
        timestamp: new Date().toISOString(),
        status: "failed",
        responseTime: 200,
        statusCode: 500,
        assertions: [{ passed: false, actual: "500", expected: "200" }],
      });

      await store.storeResult({
        checkId: "test-check",
        location: "us-west-2",
        timestamp: new Date().toISOString(),
        status: "success",
        responseTime: 75,
        statusCode: 200,
        assertions: [{ passed: true, actual: "200", expected: "200" }],
      });

      const availability = store.getAvailabilityByLocation("test-check");

      expect(availability["us-east-1"].availability).toBeCloseTo(0.5);
      expect(availability["us-west-2"].availability).toBe(1);
    });
  });

  describe("Recent Results", () => {
    it("should get recent results", async () => {
      // Store 10 results
      for (let i = 0; i < 10; i++) {
        await store.storeResult({
          checkId: "test-check",
          location: "us-east-1",
          timestamp: new Date().toISOString(),
          status: "success",
          responseTime: 50,
          statusCode: 200,
          assertions: [{ passed: true, actual: "200", expected: "200" }],
        });
      }

      const recent = store.getRecentResults("test-check", 5);
      expect(recent.length).toBe(5);
    });
  });

  describe("Clear Results", () => {
    it("should clear results", async () => {
      await store.storeResult({
        checkId: "test-check",
        location: "us-east-1",
        timestamp: new Date().toISOString(),
        status: "success",
        responseTime: 50,
        statusCode: 200,
        assertions: [{ passed: true, actual: "200", expected: "200" }],
      });

      store.clearResults("test-check");

      const results = store.getResults("test-check");
      expect(results.length).toBe(0);
    });

    it("should clear all results", async () => {
      await store.storeResult({
        checkId: "test-check-1",
        location: "us-east-1",
        timestamp: new Date().toISOString(),
        status: "success",
        responseTime: 50,
        statusCode: 200,
        assertions: [{ passed: true, actual: "200", expected: "200" }],
      });

      await store.storeResult({
        checkId: "test-check-2",
        location: "us-east-1",
        timestamp: new Date().toISOString(),
        status: "success",
        responseTime: 50,
        statusCode: 200,
        assertions: [{ passed: true, actual: "200", expected: "200" }],
      });

      store.clearResults();

      expect(store.getAllCheckIds().length).toBe(0);
    });
  });
});