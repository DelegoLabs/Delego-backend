import { describe, it, expect } from "vitest";

import type { RawChange } from "./connector/types.js";
import {
  domainEventType,
  rawChangeToCdcEvent,
  rawChangeToDomainEvent,
  tableTopic,
} from "./transform.js";

function makeRaw(overrides: Partial<RawChange> = {}): RawChange {
  return {
    id: "slot:1/0:1",
    kind: "INSERT",
    schema: "public",
    table: "orders",
    after: { id: 1, amount: 100 },
    before: undefined,
    columns: ["id", "amount"],
    source: { lsn: "1/0", txId: 5, timestamp: "2026-01-01T00:00:00.000Z" },
    sequence: 1,
    ...overrides,
  };
}

describe("transform", () => {
  it("builds a canonical CDCEvent", () => {
    const raw = makeRaw();
    const event = rawChangeToCdcEvent(raw, { idSource: () => "evt-1" });
    expect(event.eventId).toBe("evt-1");
    expect(event.eventType).toBe("INSERT");
    expect(event.table).toBe("orders");
    expect(event.schema).toBe("public");
    expect(event.after).toEqual({ id: 1, amount: 100 });
    expect(event.source.lsn).toBe("1/0");
  });

  it("builds a CDCDomainEvent with routing + schema version", () => {
    const raw = makeRaw();
    const evt = rawChangeToDomainEvent(raw, {
      topicPrefix: "cdc",
      idSource: () => "evt-1",
      schemaVersionFor: () => 3,
    });
    expect(evt.topic).toBe("cdc:public:orders");
    expect(evt.domainEventType).toBe("orders.row.inserted");
    expect(evt.schemaVersion).toBe(3);
    expect(evt.payload).toEqual({ id: 1, amount: 100 });
    expect(evt.correlationId).toBe("slot:1/0:1");
  });

  it("derives table + domain topic", () => {
    expect(tableTopic("cdc", "public", "orders")).toBe("cdc:public:orders");
    expect(domainEventType("orders", "UPDATE")).toBe("orders.row.updated");
    expect(domainEventType("orders", "DELETE")).toBe("orders.row.deleted");
  });

  it("uses the before snapshot as payload for deletes", () => {
    const raw = makeRaw({
      kind: "DELETE",
      after: undefined,
      before: { id: 1, amount: 100 },
      columns: ["id", "amount"],
    });
    const evt = rawChangeToDomainEvent(raw, { idSource: () => "evt-2" });
    expect(evt.op).toBe("DELETE");
    expect(evt.payload).toEqual({ id: 1, amount: 100 });
  });
});
