import { describe, it, expect } from "vitest";

import { createCdcMetrics, renderCdcPrometheus } from "./metrics.js";

describe("createCdcMetrics", () => {
  it("produces a running snapshot with processed count and lag", () => {
    const m = createCdcMetrics();
    m.setStatus("running");
    m.record(5, 120, "2026-01-01T00:00:00.000Z");
    const snap = m.snapshot("logical_replication");
    expect(snap.status).toBe("running");
    expect(snap.eventsProcessed).toBe(5);
    expect(snap.lagMs).toBe(120);
    expect(snap.lastEventAt).toBe("2026-01-01T00:00:00.000Z");
  });

  it("captures errors", () => {
    const m = createCdcMetrics();
    m.recordError("boom");
    const snap = m.snapshot("logical_replication");
    expect(snap.errors).toHaveLength(1);
    expect(snap.errors[0].error).toBe("boom");
  });

  it("renders prometheus text", () => {
    const m = createCdcMetrics();
    m.setStatus("running");
    m.record(3, 10, "2026-01-01T00:00:00Z");
    const text = renderCdcPrometheus(m.snapshot("logical_replication"));
    expect(text).toContain("delego_cdc_status{connector=\"logical_replication\"} 1");
    expect(text).toContain("delego_cdc_lag_ms 10");
    expect(text).toContain("delego_cdc_events_processed 3");
  });
});
