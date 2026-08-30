import { describe, it, expect } from "vitest";

import { DebeziumConnector, envelopeToRawChange, mapDebeziumOp } from "./debezium.js";
import type { CDCConfig } from "@delegolabs/types";

describe("mapDebeziumOp", () => {
  it("maps op codes", () => {
    expect(mapDebeziumOp("c")).toBe("INSERT");
    expect(mapDebeziumOp("u")).toBe("UPDATE");
    expect(mapDebeziumOp("d")).toBe("DELETE");
    expect(mapDebeziumOp("r")).toBe("INSERT");
    expect(mapDebeziumOp("t")).toBeNull();
  });
});

describe("envelopeToRawChange", () => {
  it("normalises an insert envelope", () => {
    const raw = envelopeToRawChange(
      {
        before: null,
        after: { id: 1, amount: 100 },
        source: { table: "orders", schema: "public", lsn: 100, txId: 7, ts_ms: 1700000000000 },
        op: "c",
      },
      "slot",
      1
    );
    expect(raw!.kind).toBe("INSERT");
    expect(raw!.after).toEqual({ id: 1, amount: 100 });
    expect(raw!.source.lsn).toBe("100");
    expect(raw!.source.txId).toBe(7);
  });

  it("returns null for unmatched snapshots / unknown ops", () => {
    expect(
      envelopeToRawChange({ after: { id: 1 }, op: "t" }, "slot", 1)
    ).toBeNull();
  });
});

describe("DebeziumConnector", () => {
  const config: CDCConfig = {
    connector: "debezium",
    database: { host: "h", port: 5432, name: "n", user: "u", password: "p" },
    tables: [{ schema: "public", table: "orders", pkColumns: ["id"] }],
    publication: "pub",
    slotName: "slot",
  };

  it("reads envelopes and reports position", async () => {
    let reads = 0;
    const conn = new DebeziumConnector({
      config,
      source: {
        read: async () => {
          reads += 1;
          if (reads === 1) {
            return [
              { after: { id: 1 }, source: { table: "orders", lsn: 1, ts_ms: 1700000000000 }, op: "c" },
            ];
          }
          return [];
        },
      },
    });

    await conn.initialize("0/0");
    const batch = await conn.readBatch();
    expect(batch!.changes).toHaveLength(1);
    expect(batch!.changes[0].after).toEqual({ id: 1 });
    expect(conn.position().latestLsn).toBe("1");
    expect((await conn.readBatch())).toBeNull();
  });
});
