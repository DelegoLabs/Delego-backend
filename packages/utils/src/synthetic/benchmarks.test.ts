/**
 * Tests for Performance Benchmarks
 */

import { describe, it, expect, beforeEach } from "vitest";
import { PerformanceBenchmarks } from "./benchmarks.js";

describe("PerformanceBenchmarks", () => {
  let benchmarks: PerformanceBenchmarks;

  beforeEach(() => {
    benchmarks = new PerformanceBenchmarks();
  });

  describe("Record Results", () => {
    it("should record results", () => {
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
          status: "success",
          responseTime: 100,
          statusCode: 200,
          assertions: [{ passed: true, actual: "200", expected: "200" }],
        },
        {
          checkId: "test-check",
          location: "us-east-1",
          timestamp: new Date().toISOString(),
          status: "success",
          responseTime: 150,
          statusCode: 200,
          assertions: [{ passed: true, actual: "200", expected: "200" }],
        },
      ];

      benchmarks.recordResults("test-check", results);

      const bm = benchmarks.getBenchmarks("test-check", "1h");
      expect(bm).toBeDefined();
      expect(bm?.p50).toBe(100);
      expect(bm?.avg).toBe(100);
    });
  });

  describe("Get Benchmarks", () => {
    it("should return null for no data", () => {
      const bm = benchmarks.getBenchmarks("nonexistent", "1h");
      expect(bm).toBeNull();
    });

    it("should calculate percentiles", async () => {
      const results = [];
      for (let i = 0; i < 100; i++) {
        results.push({
          checkId: "test-check",
          location: "us-east-1",
          timestamp: new Date(Date.now() - i * 1000).toISOString(),
          status: "success",
          responseTime: i * 10,
          statusCode: 200,
          assertions: [{ passed: true, actual: "200", expected: "200" }],
        });
      }

      benchmarks.recordResults("test-check", results);

      const bm = benchmarks.getBenchmarks("test-check", "1h");
      expect(bm).toBeDefined();
      expect(bm?.p50).toBeGreaterThanOrEqual(0);
      expect(bm?.p95).toBeGreaterThanOrEqual(bm?.p50 || 0);
      expect(bm?.p99).toBeGreaterThanOrEqual(bm?.p95 || 0);
    });
  });

  describe("By Location", () => {
    it("should calculate benchmarks by location", async () => {
      const results = [
        {
          checkId: "test-check",
          location: "us-east-1",
          timestamp: new Date(Date.now() - 1000).toISOString(),
          status: "success",
          responseTime: 50,
          statusCode: 200,
          assertions: [{ passed: true, actual: "200", expected: "200" }],
        },
        {
          checkId: "test-check",
          location: "us-east-1",
          timestamp: new Date(Date.now() - 2000).toISOString(),
          status: "success",
          responseTime: 100,
          statusCode: 200,
          assertions: [{ passed: true, actual: "200", expected: "200" }],
        },
        {
          checkId: "test-check",
          location: "us-west-2",
          timestamp: new Date(Date.now() - 1000).toISOString(),
          status: "success",
          responseTime: 75,
          statusCode: 200,
          assertions: [{ passed: true, actual: "200", expected: "200" }],
        },
      ];

      benchmarks.recordResults("test-check", results);

      const byLocation = benchmarks.getBenchmarksByLocation("test-check", "1h");

      expect(byLocation["us-east-1"]).toBeDefined();
      expect(byLocation["us-west-2"]).toBeDefined();
    });
  });

  describe("Availability", () => {
    it("should calculate availability by location", async () => {
      const results = [
        {
          checkId: "test-check",
          location: "us-east-1",
          timestamp: new Date(Date.now() - 1000).toISOString(),
          status: "success",
          responseTime: 50,
          statusCode: 200,
          assertions: [{ passed: true, actual: "200", expected: "200" }],
        },
        {
          checkId: "test-check",
          location: "us-east-1",
          timestamp: new Date(Date.now() - 2000).toISOString(),
          status: "failed",
          responseTime: 200,
          statusCode: 500,
          assertions: [{ passed: false, actual: "500", expected: "200" }],
        },
        {
          checkId: "test-check",
          location: "us-west-2",
          timestamp: new Date(Date.now() - 1000).toISOString(),
          status: "success",
          responseTime: 75,
          statusCode: 200,
          assertions: [{ passed: true, actual: "200", expected: "200" }],
        },
      ];

      benchmarks.recordResults("test-check", results);

      const availability = benchmarks.getAvailabilityByLocation("test-check", "1h");

      expect(availability["us-east-1"]).toBeCloseTo(0.5);
      expect(availability["us-west-2"]).toBe(1);
    });
  });

  describe("Clear Metrics", () => {
    it("should clear metrics", () => {
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

      benchmarks.recordResults("test-check", results);

      benchmarks.clearMetrics("test-check");

      const bm = benchmarks.getBenchmarks("test-check", "1h");
      expect(bm).toBeNull();
    });

    it("should clear all metrics", () => {
      benchmarks.recordResults("test-check-1", [{
        checkId: "test-check-1",
        location: "us-east-1",
        timestamp: new Date().toISOString(),
        status: "success",
        responseTime: 50,
        statusCode: 200,
        assertions: [{ passed: true, actual: "200", expected: "200" }],
      }]);

      benchmarks.recordResults("test-check-2", [{
        checkId: "test-check-2",
        location: "us-east-1",
        timestamp: new Date().toISOString(),
        status: "success",
        responseTime: 50,
        statusCode: 200,
        assertions: [{ passed: true, actual: "200", expected: "200" }],
      }]);

      benchmarks.clearMetrics();

      expect(benchmarks.getAllCheckIds().length).toBe(0);
    });
  });
});