import { mkdtemp, readFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";

vi.mock("./db.js", () => ({ sequelize: { query: vi.fn() } }));

import {
  buildReconciliationReport,
  createSorobanRpcReader,
  reportDateFor,
  runDailyLedgerReconciliation,
  type DbSettledOrder,
  type OnChainEscrowReader,
  type OnChainEscrowState,
} from "./dailyReconciliation.js";

function makeOrders(count: number): DbSettledOrder[] {
  return Array.from({ length: count }, (_, i) => ({
    orderId: `order-${i}`,
    escrowId: `escrow-${i}`,
    amountStroops: BigInt(1_000_000 + i),
    status: "released",
  }));
}

function chainFor(orders: DbSettledOrder[]): Map<string, OnChainEscrowState> {
  return new Map(orders.map((o) => [o.escrowId, { amountStroops: o.amountStroops, status: "released" }]));
}

describe("reportDateFor", () => {
  it("covers the previous UTC day regardless of time of day", () => {
    expect(reportDateFor(new Date("2026-03-01T00:00:05Z"))).toBe("2026-02-28");
    expect(reportDateFor(new Date("2026-11-22T23:59:59Z"))).toBe("2026-11-21");
  });
});

describe("buildReconciliationReport", () => {
  it("reports all matches when DB and chain agree", () => {
    const orders = makeOrders(3);
    const report = buildReconciliationReport("2026-11-21", orders, chainFor(orders));
    expect(report).toEqual({
      reportDate: "2026-11-21",
      totalOrdersChecked: 3,
      perfectMatches: 3,
      discrepancies: [],
      totalDiscrepancyAmountStroops: "0",
    });
  });

  it("flags amount mismatches, status mismatches and missing escrows with an audit trail", () => {
    const orders = makeOrders(4);
    const chain = chainFor(orders);
    chain.set("escrow-0", { amountStroops: 1_000_000n - 250n, status: "released" }); // short by 250
    chain.set("escrow-1", { amountStroops: 1_000_001n, status: "refunded" }); // status only
    chain.delete("escrow-2"); // missing on-chain

    const report = buildReconciliationReport("2026-11-21", orders, chain);

    expect(report.totalOrdersChecked).toBe(4);
    expect(report.perfectMatches).toBe(1);
    expect(report.discrepancies).toEqual([
      {
        orderId: "order-0",
        dbAmountStroops: "1000000",
        onChainAmountStroops: "999750",
        dbStatus: "released",
        onChainStatus: "released",
        differenceStroops: "-250",
      },
      {
        orderId: "order-1",
        dbAmountStroops: "1000001",
        onChainAmountStroops: "1000001",
        dbStatus: "released",
        onChainStatus: "refunded",
        differenceStroops: "0",
      },
      {
        orderId: "order-2",
        dbAmountStroops: "1000002",
        onChainAmountStroops: "0",
        dbStatus: "released",
        onChainStatus: "missing",
        differenceStroops: "-1000002",
      },
    ]);
    // sum of absolute differences: 250 + 0 + 1_000_002
    expect(report.totalDiscrepancyAmountStroops).toBe("1000252");
  });
});

describe("createSorobanRpcReader", () => {
  it("batches keys at 200 per request and merges decoded entries", async () => {
    const calls: string[][] = [];
    const fetchImpl = vi.fn(async (_url: unknown, init?: { body?: unknown }) => {
      const keys = (JSON.parse(String(init?.body)) as { params: { keys: string[] } }).params.keys;
      calls.push(keys);
      return new Response(JSON.stringify({ result: { entries: keys.map((key) => ({ key, xdr: key })) } }), {
        status: 200,
      });
    });

    const reader = createSorobanRpcReader({
      rpcUrl: "http://rpc.test",
      fetchImpl: fetchImpl as unknown as typeof fetch,
      buildKey: (id) => `k:${id}`,
      decodeEntry: ({ key }) => ({
        escrowId: key.slice(2),
        state: { amountStroops: 5n, status: "released" },
      }),
    });

    const ids = Array.from({ length: 450 }, (_, i) => `e${i}`);
    const result = await reader(ids);

    expect(calls.map((c) => c.length).sort((a, b) => a - b)).toEqual([50, 200, 200]);
    expect(result.size).toBe(450);
    expect(result.get("e449")).toEqual({ amountStroops: 5n, status: "released" });
  });

  it("throws on RPC failure so a partial read is never reported as discrepancies", async () => {
    const reader = createSorobanRpcReader({
      fetchImpl: (async () => new Response("nope", { status: 503 })) as unknown as typeof fetch,
      buildKey: (id) => id,
      decodeEntry: () => null,
    });
    await expect(reader(["a"])).rejects.toThrow(/503/);
  });
});

describe("runDailyLedgerReconciliation", () => {
  const now = new Date("2026-11-22T02:00:00Z");

  it("writes the JSON report and does not alert when everything matches", async () => {
    const orders = makeOrders(10);
    const alert = vi.fn();
    const reportDir = await mkdtemp(path.join(os.tmpdir(), "recon-"));

    const report = await runDailyLedgerReconciliation({
      now,
      reportDir,
      loadOrders: async () => orders,
      readOnChain: async () => chainFor(orders),
      alert,
    });

    expect(report.perfectMatches).toBe(10);
    expect(alert).not.toHaveBeenCalled();
    const saved = JSON.parse(await readFile(path.join(reportDir, "reconciliation-2026-11-21.json"), "utf8"));
    expect(saved.reportDate).toBe("2026-11-21");
  });

  it("alerts when discrepancies are found", async () => {
    const orders = makeOrders(5);
    const chain = chainFor(orders);
    chain.delete("escrow-3");
    const alert = vi.fn();

    const report = await runDailyLedgerReconciliation({
      now,
      loadOrders: async () => orders,
      readOnChain: async () => chain,
      alert,
    });

    expect(report.discrepancies).toHaveLength(1);
    expect(alert).toHaveBeenCalledWith(report);
  });

  it("skips the chain read when there are no orders", async () => {
    const readOnChain = vi.fn<OnChainEscrowReader>();
    const report = await runDailyLedgerReconciliation({ now, loadOrders: async () => [], readOnChain });
    expect(report.totalOrdersChecked).toBe(0);
    expect(readOnChain).not.toHaveBeenCalled();
  });

  it("reconciles 5,000 orders well under 60 seconds", async () => {
    const orders = makeOrders(5_000);
    const chain = chainFor(orders);
    chain.set("escrow-42", { amountStroops: 1n, status: "released" });

    // Simulated RPC: 200 keys per call with 20ms latency, 8 calls in flight.
    const fetchImpl = (async (_u: unknown, init?: { body?: unknown }) => {
      await new Promise((resolve) => setTimeout(resolve, 20));
      const keys = (JSON.parse(String(init?.body)) as { params: { keys: string[] } }).params.keys;
      return new Response(JSON.stringify({ result: { entries: keys.map((key) => ({ key, xdr: "" })) } }), {
        status: 200,
      });
    }) as unknown as typeof fetch;

    const readOnChain = createSorobanRpcReader({
      fetchImpl,
      buildKey: (id) => id,
      decodeEntry: ({ key }) => ({ escrowId: key, state: chain.get(key)! }),
    });

    const started = Date.now();
    const report = await runDailyLedgerReconciliation({
      now,
      loadOrders: async () => orders,
      readOnChain,
      alert: () => undefined,
    });

    expect(Date.now() - started).toBeLessThan(60_000);
    expect(report.totalOrdersChecked).toBe(5_000);
    expect(report.perfectMatches).toBe(4_999);
    expect(report.discrepancies[0].orderId).toBe("order-42");
  });
});
