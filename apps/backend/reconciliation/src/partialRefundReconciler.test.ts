import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const sdk = vi.hoisted(() => ({
  loadAccount: vi.fn(),
  simulateTransaction: vi.fn(),
  horizonServer: vi.fn(),
  rpcServer: vi.fn(),
  transactionOptions: vi.fn(),
  invokeContractFunction: vi.fn((options: unknown) => options),
}));

vi.mock("./db.js", () => ({
  sequelize: { query: vi.fn() },
}));

vi.mock("./models/AuditLog.js", () => ({
  AuditLog: { create: vi.fn() },
}));

vi.mock("@stellar/stellar-sdk", () => ({
  Networks: { PUBLIC: "public-passphrase", TESTNET: "testnet-passphrase", FUTURENET: "futurenet-passphrase" },
  Horizon: {
    Server: function (url: string) {
      sdk.horizonServer(url);
      return { loadAccount: sdk.loadAccount };
    },
  },
  rpc: {
    Server: function (url: string) {
      sdk.rpcServer(url);
      return { simulateTransaction: sdk.simulateTransaction };
    },
    Api: {
      isSimulationSuccess: (sim: { success?: boolean }) => sim.success === true,
    },
  },
  Operation: { invokeContractFunction: sdk.invokeContractFunction },
  TransactionBuilder: class {
    private operation: unknown;
    constructor(_account: unknown, options: unknown) {
      sdk.transactionOptions(options);
    }
    addOperation(operation: unknown) {
      this.operation = operation;
      return this;
    }
    setTimeout() {
      return this;
    }
    build() {
      return { operation: this.operation };
    }
  },
  nativeToScVal: (value: unknown) => value,
  scValToNative: (value: unknown) => value,
}));

import { sequelize } from "./db.js";
import { AuditLog } from "./models/AuditLog.js";
import { PartialRefundReconciler } from "./partialRefundReconciler.js";

const mockedQuery = vi.mocked(sequelize.query);
const mockedAuditCreate = vi.mocked(AuditLog.create);

interface SettlementRow {
  order_id: string;
  escrow_contract_id: string;
  buyer_address: string;
  total_order_stroops: string;
  buyer_refund_stroops: string;
  merchant_disbursement_stroops: string;
}

function row(overrides: Partial<SettlementRow> = {}): SettlementRow {
  return {
    order_id: "order-1",
    escrow_contract_id: "CESCROW",
    buyer_address: "GBUYER",
    total_order_stroops: "1000",
    buyer_refund_stroops: "300",
    merchant_disbursement_stroops: "700",
    ...overrides,
  };
}

function settlements(rows: SettlementRow[]) {
  mockedQuery.mockImplementation((async (sql: string) =>
    sql.includes("FROM partial_refund_settlements") ? [rows, rows.length] : [[], 0]) as never);
}

function onChain(buyer: bigint, merchant: bigint) {
  sdk.simulateTransaction.mockResolvedValue({
    success: true,
    result: { retval: { buyer_amount: buyer, merchant_amount: merchant } },
  });
}

function queriesMatching(fragment: string) {
  return mockedQuery.mock.calls.filter(([sql]) => String(sql).includes(fragment));
}

function replacementsOf(fragment: string) {
  return queriesMatching(fragment).map(([, options]) => (options as { replacements: Record<string, unknown> }).replacements);
}

const reconciler = new PartialRefundReconciler();

beforeEach(() => {
  sdk.loadAccount.mockResolvedValue({ accountId: "GSOURCE" });
  mockedAuditCreate.mockResolvedValue({} as never);
});

afterEach(() => {
  vi.clearAllMocks();
  delete process.env.STELLAR_NETWORK;
  delete process.env.ESCROW_READ_SOURCE_ADDRESS;
  delete process.env.SETTLEMENT_SOURCE_ADDRESS;
});

describe("PartialRefundReconciler.reconcile", () => {
  it("marks a split that matches the database as balanced and records it in the ledger", async () => {
    settlements([row()]);
    onChain(300n, 700n);

    const summary = await reconciler.reconcile();

    expect(summary).toEqual({ processed: 1, balanced: 1, discrepancies: [] });
    expect(replacementsOf("INSERT INTO accounting_ledger")).toEqual([
      {
        orderId: "order-1",
        dbBuyer: "300",
        onChainBuyer: "300",
        dbMerchant: "700",
        onChainMerchant: "700",
        isBalanced: true,
      },
    ]);
    const [timeline] = replacementsOf("INSERT INTO order_timeline");
    expect(JSON.parse(timeline.payload as string)).toEqual({
      totalOrderStroops: "1000",
      buyerRefundStroops: "300",
      merchantDisbursementStroops: "700",
      contractDisbursedBuyer: "300",
      contractDisbursedMerchant: "700",
      isBalanced: true,
      roundingLeakage: "0",
      buyerMatch: true,
      merchantMatch: true,
    });
    expect(mockedAuditCreate).toHaveBeenCalledWith(
      expect.objectContaining({
        action: "partial_refund_balanced",
        details: expect.objectContaining({ orderId: "order-1", contractDisbursedMerchant: "700" }),
      }),
    );
  });

  it("queries the escrow contract for the order's partial refund", async () => {
    settlements([row()]);
    onChain(300n, 700n);

    await reconciler.reconcile();

    expect(sdk.invokeContractFunction).toHaveBeenCalledWith({
      contract: "CESCROW",
      function: "get_partial_refund",
      args: ["order-1"],
    });
    expect(sdk.loadAccount).toHaveBeenCalledWith("GBUYER");
    expect(sdk.horizonServer).toHaveBeenCalledWith("https://horizon-testnet.stellar.org");
    expect(sdk.rpcServer).toHaveBeenCalledWith("https://soroban-testnet.stellar.org");
    expect(sdk.transactionOptions).toHaveBeenCalledWith(
      expect.objectContaining({ networkPassphrase: "testnet-passphrase" }),
    );
  });

  it("flags rounding leakage when on-chain payouts fall short of the escrow total", async () => {
    settlements([row()]);
    onChain(300n, 699n);

    const { processed, balanced, discrepancies } = await reconciler.reconcile();

    expect(processed).toBe(1);
    expect(balanced).toBe(0);
    expect(discrepancies).toEqual([
      {
        orderId: "order-1",
        record: {
          orderId: "order-1",
          totalOrderStroops: 1000n,
          buyerRefundStroops: 300n,
          merchantDisbursementStroops: 700n,
          contractDisbursedBuyer: 300n,
          contractDisbursedMerchant: 699n,
          isBalanced: false,
        },
        roundingLeakage: 1n,
        buyerMatch: true,
        merchantMatch: false,
      },
    ]);
    expect(replacementsOf("INSERT INTO accounting_ledger")[0]).toMatchObject({
      onChainMerchant: "699",
      isBalanced: false,
    });
    expect(mockedAuditCreate).toHaveBeenCalledWith(
      expect.objectContaining({
        action: "partial_refund_discrepancy",
        details: expect.objectContaining({ roundingLeakage: "1", merchantMatch: false, isBalanced: false }),
      }),
    );
  });

  it("reports negative leakage when more than the escrow total was disbursed", async () => {
    settlements([row()]);
    onChain(300n, 800n);

    const { discrepancies } = await reconciler.reconcile();

    expect(discrepancies[0].roundingLeakage).toBe(-100n);
    expect(discrepancies[0].record.isBalanced).toBe(false);
  });

  it("flags a wrong buyer/merchant split even when the total balances", async () => {
    settlements([row()]);
    onChain(400n, 600n);

    const { balanced, discrepancies } = await reconciler.reconcile();

    expect(balanced).toBe(0);
    expect(discrepancies[0]).toMatchObject({
      roundingLeakage: 0n,
      buyerMatch: false,
      merchantMatch: false,
      record: { isBalanced: true },
    });
  });

  it("compares large stroop amounts exactly", async () => {
    settlements([
      row({
        total_order_stroops: "9007199254740993",
        buyer_refund_stroops: "4503599627370497",
        merchant_disbursement_stroops: "4503599627370496",
      }),
    ]);
    onChain(4503599627370497n, 4503599627370496n);

    const { balanced, discrepancies } = await reconciler.reconcile();

    expect(balanced).toBe(1);
    expect(discrepancies).toEqual([]);
  });

  it.each([
    ["a failed simulation", () => sdk.simulateTransaction.mockResolvedValue({ success: false })],
    ["a simulation without a return value", () => sdk.simulateTransaction.mockResolvedValue({ success: true, result: {} })],
    ["an unreachable Horizon account", () => sdk.loadAccount.mockRejectedValue(new Error("account not found"))],
  ])("treats %s as zero on-chain payouts and flags the order", async (_label, arrange) => {
    settlements([row()]);
    arrange();

    const { discrepancies } = await reconciler.reconcile();

    expect(discrepancies).toHaveLength(1);
    expect(discrepancies[0]).toMatchObject({
      roundingLeakage: 1000n,
      buyerMatch: false,
      merchantMatch: false,
      record: { contractDisbursedBuyer: 0n, contractDisbursedMerchant: 0n, isBalanced: false },
    });
  });

  it("restricts the settlement query to the requested order ids", async () => {
    settlements([]);

    await reconciler.reconcile(["order-1", "order-2"]);

    const [[sql, options]] = queriesMatching("FROM partial_refund_settlements");
    expect(sql).toContain("pr.order_id IN (:orderIds)");
    expect(options).toEqual({ replacements: { orderIds: ["order-1", "order-2"] } });
  });

  it("selects every pending settlement when no order ids are given", async () => {
    settlements([]);

    const summary = await reconciler.reconcile([]);

    const [[sql, options]] = queriesMatching("FROM partial_refund_settlements");
    expect(sql).toContain("pr.status = 'partial_refund_pending'");
    expect(sql).not.toContain(":orderIds");
    expect(options).toEqual({ replacements: {} });
    expect(summary).toEqual({ processed: 0, balanced: 0, discrepancies: [] });
  });

  it("keeps flagging the discrepancy when the ledger write fails", async () => {
    settlements([row()]);
    onChain(300n, 699n);
    mockedQuery.mockImplementation((async (sql: string) => {
      if (sql.includes("FROM partial_refund_settlements")) return [[row()], 1];
      if (sql.includes("INSERT INTO accounting_ledger")) throw new Error("ledger unavailable");
      return [[], 0];
    }) as never);

    const { discrepancies } = await reconciler.reconcile();

    expect(discrepancies).toHaveLength(1);
    expect(queriesMatching("INSERT INTO order_timeline")).toHaveLength(1);
    expect(mockedAuditCreate).toHaveBeenCalledWith(
      expect.objectContaining({ action: "partial_refund_discrepancy" }),
    );
  });

  it("reconciles each order independently", async () => {
    settlements([row({ order_id: "balanced" }), row({ order_id: "short", escrow_contract_id: "CSHORT" })]);
    sdk.simulateTransaction
      .mockResolvedValueOnce({ success: true, result: { retval: { buyer_amount: 300n, merchant_amount: 700n } } })
      .mockResolvedValueOnce({ success: true, result: { retval: { buyer_amount: 299n, merchant_amount: 700n } } });

    const summary = await reconciler.reconcile();

    expect(summary.processed).toBe(2);
    expect(summary.balanced).toBe(1);
    expect(summary.discrepancies.map((d) => d.orderId)).toEqual(["short"]);
    expect(replacementsOf("INSERT INTO accounting_ledger").map((r) => r.orderId)).toEqual(["balanced", "short"]);
  });

  it("prefers the configured read source address over the buyer address", async () => {
    process.env.ESCROW_READ_SOURCE_ADDRESS = "GREADER";
    settlements([row()]);
    onChain(300n, 700n);

    await reconciler.reconcile();

    expect(sdk.loadAccount).toHaveBeenCalledWith("GREADER");
  });

  it("uses mainnet endpoints and passphrase when configured", async () => {
    process.env.STELLAR_NETWORK = "MAINNET";
    settlements([row()]);
    onChain(300n, 700n);

    await reconciler.reconcile();

    expect(sdk.horizonServer).toHaveBeenCalledWith("https://horizon.stellar.org");
    expect(sdk.rpcServer).toHaveBeenCalledWith("https://mainnet.sorobanrpc.com");
    expect(sdk.transactionOptions).toHaveBeenCalledWith(
      expect.objectContaining({ networkPassphrase: "public-passphrase" }),
    );
  });
});

describe("PartialRefundReconciler.reconcileOrder", () => {
  it("returns null when the order has no pending partial refund", async () => {
    settlements([]);

    await expect(reconciler.reconcileOrder("missing")).resolves.toBeNull();
    expect(replacementsOf("FROM partial_refund_settlements")).toEqual([{ orderIds: ["missing"] }]);
  });

  it("returns null when the order is balanced", async () => {
    settlements([row()]);
    onChain(300n, 700n);

    await expect(reconciler.reconcileOrder("order-1")).resolves.toBeNull();
  });

  it("returns the discrepancy when the order does not balance", async () => {
    settlements([row()]);
    onChain(250n, 700n);

    const result = await reconciler.reconcileOrder("order-1");

    expect(result).toMatchObject({ orderId: "order-1", roundingLeakage: 50n, buyerMatch: false, merchantMatch: true });
  });
});
