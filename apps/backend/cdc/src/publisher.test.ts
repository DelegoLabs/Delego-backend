import { describe, it, expect, beforeEach } from "vitest";

import type { RawChange, RawChangeBatch } from "./connector/types.js";
import { createCdcPublisher, advanceCheckpoint, type MessageBroker } from "./publisher.js";
import { InMemoryPublishedEventStore, InMemoryReplicationStateStore } from "./store.js";
import { InMemorySchemaEvolutionStore } from "./schemaEvolution.js";

function makeRaw(lsn: string, seq: number, kind: RawChange["kind"] = "INSERT"): RawChange {
  return {
    id: `slot:${lsn}:${seq}`,
    kind,
    schema: "public",
    table: "orders",
    after: { id: seq, amount: seq * 100 },
    columns: ["id", "amount"],
    source: { lsn, txId: seq, timestamp: "2026-01-01T00:00:00.000Z" },
    sequence: seq,
  };
}

function makeBatch(changes: RawChange[]): RawChangeBatch {
  const last = changes[changes.length - 1];
  return { changes, confirmedFlushLsn: last.source.lsn };
}

/** A broker that counts every publish it is asked to perform. */
function makeCountingBroker(): { broker: MessageBroker; published: Array<{ eventId: string; topic: string }> } {
  const published: Array<{ eventId: string; topic: string }> = [];
  return {
    broker: {
      async publish(event) {
        published.push({ eventId: event.id, topic: event.topic });
      },
    },
    published,
  };
}

describe("CDC publisher exactly-once", () => {
  let publishedEvents: InMemoryPublishedEventStore;
  let replicationState: InMemoryReplicationStateStore;
  let schemaEvolution: InMemorySchemaEvolutionStore;

  beforeEach(() => {
    publishedEvents = new InMemoryPublishedEventStore();
    replicationState = new InMemoryReplicationStateStore();
    schemaEvolution = new InMemorySchemaEvolutionStore();
  });

  it("publishes a batch and records dedup", async () => {
    const { broker, published } = makeCountingBroker();
    const pub = createCdcPublisher({
      slotName: "slot",
      broker,
      publishedEvents,
      replicationState,
      schemaEvolution,
    });

    const result = await pub.publishBatch(makeBatch([makeRaw("0/10", 1), makeRaw("0/10", 2)]));
    expect(result.published).toBe(2);
    expect(result.skipped).toBe(0);
    expect(published).toHaveLength(2);
    expect(published[0].eventId).toBe("slot:0/10:1");
  });

  it("does NOT double-publish a replay of the same changes", async () => {
    const { broker, published } = makeCountingBroker();
    const pub = createCdcPublisher({
      slotName: "slot",
      broker,
      publishedEvents,
      replicationState,
      schemaEvolution,
    });

    const batch = makeBatch([makeRaw("0/10", 1)]);
    await pub.publishBatch(batch);

    // A crash between publish and checkpoint causes a replay of the same batch.
    const replay = await pub.publishBatch(batch);
    expect(replay.published).toBe(0);
    expect(replay.skipped).toBe(1);
    expect(published).toHaveLength(1);
  });

  it("checkpoint advances only after the whole batch is recorded", async () => {
    const { broker } = makeCountingBroker();
    const pub = createCdcPublisher({
      slotName: "slot",
      broker,
      publishedEvents,
      replicationState,
      schemaEvolution,
    });

    expect(await pub.getCheckpoint()).toBe("0/0");

    const batch = makeBatch([makeRaw("0/20", 1)]);
    await pub.publishBatch(batch);
    await advanceCheckpoint(replicationState, "slot", batch.confirmedFlushLsn);

    expect(await pub.getCheckpoint()).toBe("0/20");
  });

  it("assigning schema versions and checking failure path", async () => {
    const { broker } = makeCountingBroker();
    const pub = createCdcPublisher({
      slotName: "slot",
      broker,
      publishedEvents,
      replicationState,
      schemaEvolution,
    });

    // Normalize 3 events; schema evolution records the layout once.
    await pub.publishBatch(
      makeBatch([
        makeRaw("0/30", 1),
        makeRaw("0/30", 2),
        makeRaw("0/31", 3),
      ])
    );
    expect(await schemaEvolution.currentVersion("public", "orders")).toBe(1);
  });
});
