import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

import type { CDCConfig } from "@delegolabs/types";
import type { CDCConnector } from "./connector/types.js";
import { createCdcPipeline } from "./pipeline.js";
import { createCdcPublisher, type CdcPublisher, type MessageBroker } from "./publisher.js";
import { InMemoryPublishedEventStore, InMemoryReplicationStateStore } from "./store.js";
import { InMemorySchemaEvolutionStore } from "./schemaEvolution.js";
import { createCdcMetrics } from "./metrics.js";

const config: CDCConfig = {
  connector: "logical_replication",
  database: { host: "h", port: 5432, name: "n", user: "u", password: "p" },
  tables: [{ schema: "public", table: "orders", pkColumns: ["id"] }],
  publication: "pub",
  slotName: "slot",
};

interface FakeConnector extends CDCConnector {
  initLsn: string[];
  closed: boolean;
}

function makeConnector(overrides: Partial<FakeConnector> = {}): FakeConnector {
  const state: FakeConnector = {
    kind: "logical_replication",
    slotName: "slot",
    closed: false,
    initLsn: [],
    initialize: vi.fn(async (lsn: string) => {
      state.initLsn.push(lsn);
      return lsn;
    }),
    readBatch: vi.fn(async () => null),
    commit: vi.fn(async () => {}),
    position: vi.fn(() => ({ startingLsn: "0/0", latestLsn: "0/0", lagMs: 0, lastEventAt: "" })),
    close: vi.fn(async () => {
      state.closed = true;
    }),
    ...overrides,
  };
  return state;
}

describe("CDC pipeline", () => {
  let publishedEvents: InMemoryPublishedEventStore;
  let replicationState: InMemoryReplicationStateStore;
  let schemaEvolution: InMemorySchemaEvolutionStore;
  let broker: MessageBroker;
  let publisher: CdcPublisher;

  beforeEach(() => {
    publishedEvents = new InMemoryPublishedEventStore();
    replicationState = new InMemoryReplicationStateStore();
    schemaEvolution = new InMemorySchemaEvolutionStore();
    broker = { publish: async () => {} };
    publisher = createCdcPublisher({
      slotName: "slot",
      broker,
      publishedEvents,
      replicationState,
      schemaEvolution,
    });
    vi.useRealTimers();
  });

  afterEach(() => {
    vi.clearAllTimers();
  });

  it("resumes from the durable checkpoint on start (failover recovery)", async () => {
    await replicationState.set({ slotName: "slot", confirmedFlushLsn: "0/FF" });
    const conn = makeConnector();

    const pipeline = await createCdcPipeline({
      config,
      connector: conn,
      publisher,
      replicationState,
      broker,
      pollIntervalMs: 1000,
    });
    await pipeline.start();
    expect(conn.initLsn).toEqual(["0/FF"]);
    await pipeline.stop();
  });

  it("tracks pause/resume and reports running state", async () => {
    const conn = makeConnector();
    const pipeline = await createCdcPipeline({
      config,
      connector: conn,
      publisher,
      replicationState,
      broker,
      pollIntervalMs: 1000,
      metrics: createCdcMetrics(),
    });
    await pipeline.start();
    expect(pipeline.isRunning()).toBe(true);

    await pipeline.pause();
    expect(pipeline.isRunning()).toBe(false);
    expect(pipeline.getMetrics().status).toBe("stopped");

    await pipeline.resume();
    expect(pipeline.isRunning()).toBe(true);
    expect(pipeline.getMetrics().status).toBe("running");

    await pipeline.stop();
  });

  it("reports error status when the connector fails", async () => {
    const metrics = createCdcMetrics();
    const conn = makeConnector({
      readBatch: vi.fn(async () => {
        throw new Error("wal unavailable");
      }),
    });

    const pipeline = await createCdcPipeline({
      config,
      connector: conn,
      publisher,
      replicationState,
      broker,
      pollIntervalMs: 10,
      metrics,
    });
    await pipeline.start();
    await new Promise((r) => setTimeout(r, 40));
    expect(pipeline.getMetrics().status).toBe("error");
    expect(pipeline.getMetrics().errors.length).toBeGreaterThan(0);
    await pipeline.stop();
  });

  it("publishes a batch end-to-end and advances the checkpoint", async () => {
    const conn = makeConnector({
      readBatch: vi.fn(async () => ({
        changes: [
          {
            id: "slot:0/10:1",
            kind: "INSERT" as const,
            schema: "public",
            table: "orders",
            after: { id: 1, amount: 42 },
            columns: ["id", "amount"],
            source: { lsn: "0/10", txId: 1, timestamp: "2026-01-01T00:00:00.000Z" },
            sequence: 1,
          },
        ],
        confirmedFlushLsn: "0/10",
      })),
    });

    const pipeline = await createCdcPipeline({
      config,
      connector: conn,
      publisher,
      replicationState,
      broker,
      pollIntervalMs: 5,
      metrics: createCdcMetrics(),
    });
    await pipeline.start();
    await new Promise((r) => setTimeout(r, 40));

    expect(await replicationState.get("slot")).not.toBeNull();
    expect((await replicationState.get("slot"))!.confirmedFlushLsn).toBe("0/10");
    await pipeline.stop();
  });
});
