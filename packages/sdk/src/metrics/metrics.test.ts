import { describe, it, expect, beforeEach } from "vitest";
import { MetricsSDK } from "./index.js";

describe("Issue #158 — MetricsSDK", () => {
  let sdk: MetricsSDK;

  beforeEach(() => {
    sdk = new MetricsSDK({
      serviceName: "payment-gateway",
      serviceVersion: "2.1.0",
      environment: "production",
    });
  });

  it("enforces metric naming conventions", () => {
    expect(() =>
      sdk.register({
        name: "invalid-metric-name",
        type: "counter",
        help: "Invalid name with dashes",
        labels: [],
      })
    ).toThrow(/Invalid metric name/);

    expect(() =>
      sdk.register({
        name: "valid_metric_name_total",
        type: "counter",
        help: "Valid metric name",
        labels: [],
      })
    ).not.toThrow();
  });

  it("increments counters and attaches trace exemplars", () => {
    const counter = sdk.counter("http_requests_total");
    counter.inc(1, { method: "POST" }, { traceId: "trace-abc", spanId: "span-123" });
    counter.inc(2, { method: "POST" });

    expect(counter.get()).toBe(3);
    const exemplars = counter.getExemplars();
    expect(exemplars).toHaveLength(1);
    expect(exemplars[0].traceId).toBe("trace-abc");
    expect(exemplars[0].labels.service).toBe("payment-gateway");
    expect(exemplars[0].labels.env).toBe("production");
  });

  it("observes histograms and calculates bucket distributions", () => {
    const hist = sdk.histogram("http_request_duration_seconds");
    hist.observe(0.02);
    hist.observe(0.08);
    hist.observe(1.5);

    const data = hist.get();
    expect(data.count).toBe(3);
    expect(data.sum).toBeCloseTo(1.6);
  });

  it("observes summaries and calculates percentiles", () => {
    const summary = sdk.summary("rpc_processing_time_ms");
    for (let i = 1; i <= 100; i++) {
      summary.observe(i);
    }

    const data = summary.get();
    expect(data.count).toBe(100);
    expect(data.p50).toBe(51);
    expect(data.p95).toBe(96);
    expect(data.p99).toBe(100);
  });

  it("generates markdown documentation of registered metrics", () => {
    sdk.register({
      name: "delegation_operations_total",
      type: "counter",
      unit: "operations",
      help: "Total number of delegation transactions executed",
      labels: [{ name: "status", description: "Status code", required: true }],
    });

    const docs = sdk.generateDocs();
    expect(docs).toContain("# Application Metrics Documentation");
    expect(docs).toContain("`delegation_operations_total`");
    expect(docs).toContain("`status*`");
  });
});
