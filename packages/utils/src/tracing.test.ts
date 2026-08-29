import { describe, it, expect } from "vitest";
import {
  sampleTrace,
  buildSpanAttributes,
  buildHttpSpanAttributes,
  buildDbSpanAttributes,
  buildErrorSpanAttributes,
  computeTraceMetrics,
  type TraceConfig,
} from "./tracing.js";

function buildConfig(overrides: Partial<TraceConfig> = {}): TraceConfig {
  return {
    serviceName: "gateway",
    sampler: "trace_id_ratio",
    sampleRate: 0.1,
    exporter: "otlp",
    endpoint: "http://collector:4318",
    propagators: ["tracecontext"],
    ...overrides,
  };
}

describe("sampleTrace", () => {
  it("always samples with always_on", () => {
    const config = buildConfig({ sampler: "always_on" });
    expect(sampleTrace(config, { traceId: "abc", hasParent: false })).toBe(true);
  });

  it("never samples with always_off", () => {
    const config = buildConfig({ sampler: "always_off" });
    expect(sampleTrace(config, { traceId: "abc", hasParent: false })).toBe(false);
  });

  it("is deterministic for the same trace id under trace_id_ratio", () => {
    const config = buildConfig({ sampler: "trace_id_ratio", sampleRate: 0.5 });
    const first = sampleTrace(config, { traceId: "trace-42", hasParent: false });
    const second = sampleTrace(config, { traceId: "trace-42", hasParent: false });
    expect(first).toBe(second);
  });

  it("samples roughly sampleRate fraction of trace ids", () => {
    const config = buildConfig({ sampler: "trace_id_ratio", sampleRate: 0.5 });
    const sampled = Array.from({ length: 1000 }, (_, i) =>
      sampleTrace(config, { traceId: `trace-${i}`, hasParent: false }),
    ).filter(Boolean).length;
    // Loose bound — this is a hash-based approximation, not a precise RNG.
    expect(sampled).toBeGreaterThan(350);
    expect(sampled).toBeLessThan(650);
  });

  it("respects sampleRate 0 (samples nothing)", () => {
    const config = buildConfig({ sampler: "trace_id_ratio", sampleRate: 0 });
    const results = Array.from({ length: 100 }, (_, i) =>
      sampleTrace(config, { traceId: `t-${i}`, hasParent: false }),
    );
    expect(results.every((r) => r === false)).toBe(true);
  });

  it("respects sampleRate 1 (samples everything)", () => {
    const config = buildConfig({ sampler: "trace_id_ratio", sampleRate: 1 });
    const results = Array.from({ length: 100 }, (_, i) =>
      sampleTrace(config, { traceId: `t-${i}`, hasParent: false }),
    );
    expect(results.every((r) => r === true)).toBe(true);
  });

  it("parent_based inherits the parent's sampling decision when a parent exists", () => {
    const config = buildConfig({ sampler: "parent_based" });
    expect(sampleTrace(config, { traceId: "x", hasParent: true, parentSampled: true })).toBe(true);
    expect(sampleTrace(config, { traceId: "x", hasParent: true, parentSampled: false })).toBe(false);
  });

  it("parent_based falls back to ratio sampling for a root span with no parent", () => {
    const config = buildConfig({ sampler: "parent_based", sampleRate: 1 });
    expect(sampleTrace(config, { traceId: "x", hasParent: false })).toBe(true);
  });
});

describe("buildSpanAttributes", () => {
  it("omits undefined-valued keys", () => {
    const attrs = buildSpanAttributes({ "http.method": "GET", "http.url": undefined });
    expect(attrs).toEqual({ "http.method": "GET" });
    expect("http.url" in attrs).toBe(false);
  });
});

describe("buildHttpSpanAttributes", () => {
  it("marks a 2xx response as not an error", () => {
    const attrs = buildHttpSpanAttributes("GET", "/health", 200);
    expect(attrs.error).toBe(false);
  });

  it("marks a 4xx response as an error", () => {
    const attrs = buildHttpSpanAttributes("POST", "/orders", 404);
    expect(attrs.error).toBe(true);
  });

  it("marks a 5xx response as an error", () => {
    const attrs = buildHttpSpanAttributes("POST", "/orders", 500);
    expect(attrs.error).toBe(true);
  });
});

describe("buildDbSpanAttributes", () => {
  it("shapes operation and statement into span attributes", () => {
    const attrs = buildDbSpanAttributes("SELECT", "SELECT * FROM orders WHERE id = $1");
    expect(attrs["db.operation"]).toBe("SELECT");
    expect(attrs["db.statement"]).toBe("SELECT * FROM orders WHERE id = $1");
  });
});

describe("buildErrorSpanAttributes", () => {
  it("marks the span as an error with the exception message", () => {
    const attrs = buildErrorSpanAttributes(new Error("boom"));
    expect(attrs.error).toBe(true);
    expect(attrs["error.message"]).toBe("boom");
  });
});

describe("computeTraceMetrics", () => {
  it("computes p50/p99 latency, error rate, and avg spans per trace", () => {
    const durations = Array.from({ length: 100 }, (_, i) => i + 1); // 1..100
    const metrics = computeTraceMetrics({ traceCount: 10, spanDurationsMs: durations, errorSpanCount: 5 });
    expect(metrics.tracesReceived).toBe(10);
    expect(metrics.spansReceived).toBe(100);
    expect(metrics.avgSpansPerTrace).toBe(10);
    expect(metrics.errorRate).toBe(0.05);
    expect(metrics.latencyP50Ms).toBeGreaterThan(40);
    expect(metrics.latencyP99Ms).toBeGreaterThan(metrics.latencyP50Ms);
  });

  it("handles zero traces without dividing by zero", () => {
    const metrics = computeTraceMetrics({ traceCount: 0, spanDurationsMs: [], errorSpanCount: 0 });
    expect(metrics.avgSpansPerTrace).toBe(0);
    expect(metrics.errorRate).toBe(0);
    expect(metrics.latencyP50Ms).toBe(0);
  });
});
