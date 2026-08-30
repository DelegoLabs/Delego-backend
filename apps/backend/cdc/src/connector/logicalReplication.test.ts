import { describe, it, expect } from "vitest";

import { parseDecodeLine, parseTupleFragment } from "./logicalReplication.js";
import type { CDCConfig } from "@delegolabs/types";

describe("parseDecodeLine", () => {
  it("parses an INSERT line", () => {
    const raw = parseDecodeLine(
      "table public.orders: INSERT: id[integer]:1 amount[integer]:100",
      "0/1F",
      7,
      "2026-01-01T00:00:00.000Z",
      "slot",
      1
    );
    expect(raw).not.toBeNull();
    expect(raw!.kind).toBe("INSERT");
    expect(raw!.schema).toBe("public");
    expect(raw!.table).toBe("orders");
    expect(raw!.after).toEqual({ id: 1, amount: 100 });
    expect(raw!.id).toBe("slot:0/1F:1");
    expect(raw!.source.txId).toBe(7);
  });

  it("parses an UPDATE with old-key + new-tuple", () => {
    const raw = parseDecodeLine(
      "table public.orders: UPDATE: old-key: id[integer]:1 new-tuple: id[integer]:1 amount[integer]:101",
      "0/20",
      8,
      "2026-01-01T00:00:00.000Z",
      "slot",
      1
    );
    expect(raw!.kind).toBe("UPDATE");
    expect(raw!.before).toEqual({ id: 1 });
    expect(raw!.after).toEqual({ id: 1, amount: 101 });
  });

  it("parses a DELETE line", () => {
    const raw = parseDecodeLine(
      "table public.orders: DELETE: id[integer]:1",
      "0/21",
      9,
      "2026-01-01T00:00:00.000Z",
      "slot",
      1
    );
    expect(raw!.kind).toBe("DELETE");
    expect(raw!.before).toEqual({ id: 1 });
    expect(raw!.after).toBeUndefined();
  });

  it("returns null for non-table lines", () => {
    expect(parseDecodeLine("BEGIN: 1", "0/1", 1, "ts", "slot", 1)).toBeNull();
  });

  it("coerces NULLs and booleans", () => {
    const raw = parseDecodeLine(
      "table public.users: INSERT: id[integer]:1 is_active[boolean]:t note[text]:NULL",
      "0/22",
      1,
      "ts",
      "slot",
      1
    );
    expect(raw!.after).toEqual({ id: 1, is_active: true, note: null });
  });
});

describe("parseTupleFragment", () => {
  it("parses multiple columns", () => {
    expect(parseTupleFragment("id[integer]:1 name[text]:alice")).toEqual({
      id: 1,
      name: "alice",
    });
  });
});

describe("LogicalReplicationConnector connector flow", () => {
  it("polls changes and builds batches, committing the flush LSN", async () => {
    const config: CDCConfig = {
      connector: "logical_replication",
      database: { host: "localhost", port: 5432, name: "delego", user: "u", password: "p" },
      tables: [{ schema: "public", table: "orders", pkColumns: ["id"] }],
      publication: "pub",
      slotName: "slot",
    };

    // Use a fake connector driven through run/read wiring.
    const { LogicalReplicationConnector } = await import("./logicalReplication.js");
    const conn = new LogicalReplicationConnector({
      config,
      pool: {} as never,
      run: async () => {},
    });

    let calls = 0;
    conn._setPollSource(async (lsn, _limit) => {
      calls += 1;
      if (calls === 1) {
        expect(lsn).toBe("0/0");
        return [
          { lsn: "0/A", xid: 1, data: "table public.orders: INSERT: id[integer]:1 amount[integer]:50" },
        ];
      }
      return [];
    });

    const resume = await conn.initialize("0/0");
    expect(resume).toBe("0/0");

    const batch = await conn.readBatch();
    expect(batch).not.toBeNull();
    expect(batch!.changes).toHaveLength(1);
    expect(batch!.changes[0].after).toEqual({ id: 1, amount: 50 });
    expect(batch!.confirmedFlushLsn).toBe("0/A");

    await conn.commit("0/A");

    const idle = await conn.readBatch();
    expect(idle).toBeNull();
  });
});
