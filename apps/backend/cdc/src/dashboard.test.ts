import type { CDCMetrics } from "@delegolabs/types";
import { describe, expect, it } from "vitest";
import { renderCdcDashboard } from "./dashboard.js";

const metrics: CDCMetrics = {
  connector: "debezium",
  status: "running",
  eventsProcessed: 8_423,
  eventsPerSecond: 14,
  lagMs: 1_250,
  lastEventAt: "2026-01-01T00:00:00Z",
  errors: [],
};

describe("renderCdcDashboard", () => {
  it("renders the current connector status and formatted lag", () => {
    const page = renderCdcDashboard(metrics);

    expect(page).toContain(">debezium</div>");
    expect(page).toContain(">running</span>");
    expect(page).toContain(`id="lag">${metrics.lagMs.toLocaleString()}</div>`);
    expect(page).toContain('id="lagbar" style="width:25%"');
  });

  it("caps the lag bar without capping the displayed lag", () => {
    const lagMs = 7_500;
    const page = renderCdcDashboard({ ...metrics, lagMs });

    expect(page).toContain(`id="lag">${lagMs.toLocaleString()}</div>`);
    expect(page).toContain('id="lagbar" style="width:100%"');
  });

  it("shows zero lag and an empty error history before receiving metrics", () => {
    const page = renderCdcDashboard(null);

    expect(page).toContain(">stopped</span>");
    expect(page).toContain('id="lag">0</div>');
    expect(page).toContain("No errors");
  });

  it("renders connector errors as text", () => {
    const page = renderCdcDashboard({
      ...metrics,
      status: "error",
      errors: [{ timestamp: metrics.lastEventAt, error: 'Lag < limit & status is "unknown"' }],
    });

    expect(page).toContain(`<td>${metrics.lastEventAt}</td>`);
    expect(page).toContain("<td>Lag &lt; limit &amp; status is &quot;unknown&quot;</td>");
    expect(page).not.toContain("No errors");
  });
});
