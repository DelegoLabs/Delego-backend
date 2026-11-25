import { once } from "node:events";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { startHttpServer } from "@delegolabs/utils";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createCdcMetrics } from "./metrics.js";
import { registerCdcRoutes, type CdcRoutesDeps } from "./routes.js";

const fixturePassword = "local-fixture-only";
const config: CdcRoutesDeps["config"] = {
  connector: "debezium",
  database: { host: "localhost", port: 5432, name: "test", user: "test", password: fixturePassword },
  tables: [{ schema: "public", table: "bookings", pkColumns: ["id"] }],
  publication: "test_publication",
  slotName: "test_slot",
};

describe("CDC HTTP routes", () => {
  let server: Server;
  let baseUrl: string;
  const onPause = vi.fn<() => Promise<void>>();
  const onResume = vi.fn<() => Promise<void>>();

  beforeEach(async () => {
    onPause.mockReset().mockResolvedValue(undefined);
    onResume.mockReset().mockResolvedValue(undefined);
    const metrics = createCdcMetrics();
    metrics.setStatus("running");
    metrics.record(3, 1_250, "2026-01-01T00:00:00Z");
    const deps: CdcRoutesDeps = {
      config,
      metrics,
      getPositionLsn: () => ({ latestLsn: "0/16B6C50", lagMs: 1_250 }),
      onPause,
      onResume,
    };

    server = startHttpServer({
      host: "127.0.0.1",
      port: 0,
      serviceName: "cdc-test",
      routes: registerCdcRoutes(deps),
    });
    await once(server, "listening");
    baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });

  afterEach(async () => {
    await new Promise<void>((resolve, reject) => {
      server.close((error) => error ? reject(error) : resolve());
    });
  });

  it("reports the active connector and its replication position", async () => {
    const metrics = await fetch(`${baseUrl}/api/v1/cdc/metrics`);
    const position = await fetch(`${baseUrl}/api/v1/cdc/position`);

    expect(metrics.status).toBe(200);
    expect(await metrics.json()).toMatchObject({
      data: { connector: "debezium", status: "running", lagMs: 1_250, eventsProcessed: 3 },
      error: null,
    });
    expect(position.status).toBe(200);
    expect(await position.json()).toEqual({ data: { latestLsn: "0/16B6C50", lagMs: 1_250 }, error: null });
  });

  it("redacts the database password in the config response", async () => {
    const response = await fetch(`${baseUrl}/api/v1/cdc/config`);
    const body = await response.text();

    expect(response.status).toBe(200);
    expect(JSON.parse(body)).toMatchObject({
      data: { connector: "debezium", database: { user: "test", password: "***" } }, error: null,
    });
    expect(body).not.toContain(fixturePassword);
  });

  it.each([
    { action: "pause", status: "paused" },
    { action: "resume", status: "running" },
  ])("calls the connector $action and returns its state", async ({ action, status }) => {
    const handler = action === "pause" ? onPause : onResume;

    const response = await fetch(`${baseUrl}/api/v1/cdc/${action}`, { method: "POST" });

    expect(handler).toHaveBeenCalledOnce();
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ data: { status }, error: null });
  });

  it("returns an HTTP error when the connector refuses to pause", async () => {
    onPause.mockRejectedValue(new Error("Connector unavailable"));

    const response = await fetch(`${baseUrl}/api/v1/cdc/pause`, { method: "POST" });

    expect(response.status).toBe(500);
    expect(await response.json()).toMatchObject({ data: null, error: { code: "INTERNAL_ERROR" } });
  });

  it("serves current monitoring data as uncached HTML and Prometheus text", async () => {
    const dashboard = await fetch(`${baseUrl}/api/v1/cdc/dashboard`);
    const prometheus = await fetch(`${baseUrl}/metrics`);

    expect(dashboard.status).toBe(200);
    expect(dashboard.headers.get("content-type")).toContain("text/html");
    expect(dashboard.headers.get("cache-control")).toBe("no-store");
    expect(await dashboard.text()).toContain(`id="lag">${(1_250).toLocaleString()}</div>`);
    expect(prometheus.status).toBe(200);
    expect(prometheus.headers.get("content-type")).toContain("text/plain");
    expect(prometheus.headers.get("cache-control")).toBe("no-store");
    expect(await prometheus.text()).toContain("delego_cdc_lag_ms 1250\n");
  });
});
