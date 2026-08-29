import { describe, it, expect } from "vitest";
import { ServiceMetricsRegistry } from "./serviceMetrics";

describe("ServiceMetricsRegistry", () => {
  it("increments and reads back a counter", () => {
    const registry = new ServiceMetricsRegistry();
    const counter = registry.counter("orders_created_total");
    counter.inc();
    counter.inc(4);
    expect(counter.value()).toBe(5);
  });

  it("tracks counter values per label set independently", () => {
    const registry = new ServiceMetricsRegistry();
    const counter = registry.counter("requests_total");
    counter.inc(1, { route: "/a" });
    counter.inc(1, { route: "/a" });
    counter.inc(1, { route: "/b" });

    expect(counter.value({ route: "/a" })).toBe(2);
    expect(counter.value({ route: "/b" })).toBe(1);
  });

  it("sets, increments, and decrements a gauge", () => {
    const registry = new ServiceMetricsRegistry();
    const gauge = registry.gauge("active_users");
    gauge.set(10);
    gauge.inc(2);
    gauge.dec(3);
    expect(gauge.value()).toBe(9);
  });

  it("records histogram observations with count and sum", () => {
    const registry = new ServiceMetricsRegistry();
    const hist = registry.histogram("job_duration_seconds");
    hist.observe(1.5);
    hist.observe(2.5);
    expect(hist.count()).toBe(2);
    expect(hist.sum()).toBe(4);
  });

  it("returns the same instance for repeated calls with the same metric name", () => {
    const registry = new ServiceMetricsRegistry();
    const a = registry.counter("same_name");
    const b = registry.counter("same_name");
    a.inc();
    expect(b.value()).toBe(1);
  });

  it("recordHttpRequest updates requests-total, duration, and errors-total together", () => {
    const registry = new ServiceMetricsRegistry();
    registry.recordHttpRequest(0.2, { method: "GET", route: "/orders", statusCode: 200 });
    registry.recordHttpRequest(0.5, { method: "GET", route: "/orders", statusCode: 500 });

    const labels = { method: "GET", route: "/orders", status: "200" };
    expect(registry.red.httpRequestsTotal.value(labels)).toBe(1);
    expect(registry.red.httpRequestDurationSeconds.count(labels)).toBe(1);
    expect(registry.red.httpErrorsTotal.value(labels)).toBe(0);

    const errorLabels = { method: "GET", route: "/orders", status: "500" };
    expect(registry.red.httpErrorsTotal.value(errorLabels)).toBe(1);
  });

  it("does not count a 4xx response as an error (only 5xx)", () => {
    const registry = new ServiceMetricsRegistry();
    registry.recordHttpRequest(0.1, { method: "GET", route: "/x", statusCode: 404 });
    const labels = { method: "GET", route: "/x", status: "404" };
    expect(registry.red.httpErrorsTotal.value(labels)).toBe(0);
  });

  it("renders Prometheus text exposition format for every metric kind", () => {
    const registry = new ServiceMetricsRegistry();
    registry.counter("c1").inc(3);
    registry.gauge("g1").set(7);
    registry.histogram("h1").observe(2);

    const text = registry.toPrometheusText();
    expect(text).toContain("# TYPE c1 counter");
    expect(text).toContain("c1 3");
    expect(text).toContain("# TYPE g1 gauge");
    expect(text).toContain("g1 7");
    expect(text).toContain("h1_count 1");
    expect(text).toContain("h1_sum 2");
  });

  it("renders labeled series instead of collapsing them to the unlabeled value", () => {
    const registry = new ServiceMetricsRegistry();
    registry.counter("lock_acquire_total").inc(1, { level: "workflow", result: "acquired" });
    registry.counter("lock_acquire_total").inc(2, { level: "step", result: "contended" });
    registry.gauge("lock_held").set(4, { level: "workflow" });
    registry.histogram("lock_acquire_duration_seconds").observe(0.01, { level: "workflow", result: "acquired" });

    const text = registry.toPrometheusText();
    expect(text).toContain('lock_acquire_total{level="workflow",result="acquired"} 1');
    expect(text).toContain('lock_acquire_total{level="step",result="contended"} 2');
    expect(text).toContain('lock_held{level="workflow"} 4');
    expect(text).toContain('lock_acquire_duration_seconds_count{level="workflow",result="acquired"} 1');
    expect(text).not.toMatch(/^lock_acquire_total 0$/m);
  });
});
