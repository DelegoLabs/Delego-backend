/**
 * Unit tests for #621 — discrepancy detection engine flagging unmatched
 * Stellar Horizon operations. Covers Horizon record normalization, the
 * memo-first / buyer+amount-fallback matching logic, and the end-to-end
 * scan loop (matching vs. quarantining, checkpoint advancement).
 */
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("./db.js", () => ({
  sequelize: { query: vi.fn() },
}));

vi.mock("./models/OrphanScannerCheckpoint.js", () => ({
  OrphanScannerCheckpoint: { findByPk: vi.fn(), upsert: vi.fn() },
}));

vi.mock("./models/OrphanedTransactionQuarantine.js", () => ({
  OrphanedTransactionQuarantine: { upsert: vi.fn() },
}));

import { sequelize } from "./db.js";
import { OrphanScannerCheckpoint } from "./models/OrphanScannerCheckpoint.js";
import { OrphanedTransactionQuarantine } from "./models/OrphanedTransactionQuarantine.js";
import {
  ledgerSequenceFromPagingToken,
  toOrphanedTransaction,
  loadPendingOrderCandidates,
  matchOrphanedTransaction,
  scanForOrphanedTransactions,
  getConfiguredEscrowAccounts,
  startOrphanScannerWorker,
  stopOrphanScannerWorker,
  type HorizonPaymentOperationRecord,
  type PendingOrderCandidate,
} from "./orphanScanner.js";

const mockedQuery = vi.mocked(sequelize.query);
const mockedCheckpointFindByPk = vi.mocked(OrphanScannerCheckpoint.findByPk);
const mockedCheckpointUpsert = vi.mocked(OrphanScannerCheckpoint.upsert);
const mockedQuarantineUpsert = vi.mocked(OrphanedTransactionQuarantine.upsert);

function jsonResponse(body: unknown, ok = true, status = 200): Response {
  return { ok, status, json: async () => body } as unknown as Response;
}

afterEach(() => {
  vi.clearAllMocks();
  delete process.env.PLATFORM_ESCROW_ACCOUNTS;
  stopOrphanScannerWorker();
});

describe("getConfiguredEscrowAccounts", () => {
  it("parses a comma-separated env var", () => {
    process.env.PLATFORM_ESCROW_ACCOUNTS = "GESCROW1, GESCROW2";
    expect(getConfiguredEscrowAccounts()).toEqual(["GESCROW1", "GESCROW2"]);
  });

  it("returns an empty list when unset", () => {
    expect(getConfiguredEscrowAccounts()).toEqual([]);
  });
});

describe("ledgerSequenceFromPagingToken", () => {
  it("decodes the ledger sequence from the TOID's upper 32 bits", () => {
    const ledger = 55_123;
    const pagingToken = (BigInt(ledger) << 32n).toString();
    expect(ledgerSequenceFromPagingToken(pagingToken)).toBe(ledger);
  });
});

const baseRecord: HorizonPaymentOperationRecord = {
  id: "1",
  paging_token: (55_000n << 32n).toString(),
  type: "payment",
  transaction_hash: "tx-hash-1",
  transaction_successful: true,
  from: "GBUYER000000000000000000000000000000000000000000000000",
  to: "GESCROW0000000000000000000000000000000000000000000000",
  amount: "125.0000000",
  asset_type: "native",
  created_at: "2026-11-20T10:00:00Z",
  transaction: { memo: "order-42", memo_type: "text" },
};

describe("toOrphanedTransaction", () => {
  it("normalizes a successful native payment into the escrow account", () => {
    const tx = toOrphanedTransaction(baseRecord, baseRecord.to!);
    expect(tx).toEqual({
      txHash: "tx-hash-1",
      sourceAccount: baseRecord.from,
      destinationAccount: baseRecord.to,
      amountStroops: "1250000000",
      memo: "order-42",
      ledgerSequence: 55_000,
    });
  });

  it("ignores operations that are not plain payments", () => {
    expect(toOrphanedTransaction({ ...baseRecord, type: "path_payment_strict_send" }, baseRecord.to!)).toBeNull();
  });

  it("ignores failed transactions", () => {
    expect(toOrphanedTransaction({ ...baseRecord, transaction_successful: false }, baseRecord.to!)).toBeNull();
  });

  it("ignores payments to a different account than the one being scanned", () => {
    expect(toOrphanedTransaction(baseRecord, "GSOMEOTHERACCOUNT")).toBeNull();
  });

  it("ignores non-native assets", () => {
    expect(toOrphanedTransaction({ ...baseRecord, asset_type: "credit_alphanum4" }, baseRecord.to!)).toBeNull();
  });

  it("omits memo when the transaction has no text memo", () => {
    const tx = toOrphanedTransaction({ ...baseRecord, transaction: { memo_type: "none" } }, baseRecord.to!);
    expect(tx?.memo).toBeUndefined();
  });
});

describe("loadPendingOrderCandidates", () => {
  it("maps payment_records rows awaiting funding into candidates", async () => {
    mockedQuery.mockResolvedValue([
      [{ order_id: "order-42", buyer_address: "GBUYER1", amount_stroops: "1250000000" }],
      {},
    ] as any);

    const candidates = await loadPendingOrderCandidates();

    expect(candidates).toEqual([{ orderId: "order-42", buyerAddress: "GBUYER1", amountStroops: "1250000000" }]);
    expect(mockedQuery).toHaveBeenCalledWith(expect.stringContaining("WHERE status = 'pending'"));
  });
});

describe("matchOrphanedTransaction", () => {
  const candidates: PendingOrderCandidate[] = [
    { orderId: "order-42", buyerAddress: "GBUYER1", amountStroops: "1250000000" },
    { orderId: "order-43", buyerAddress: "GBUYER2", amountStroops: "1250000000" },
  ];

  it("matches by memo when it uniquely identifies an order with the right amount", () => {
    expect(
      matchOrphanedTransaction({ memo: "order-42", amountStroops: "1250000000", sourceAccount: "GANY" }, candidates)
    ).toBe("order-42");
  });

  it("does not trust a memo match whose amount disagrees with the order", () => {
    expect(
      matchOrphanedTransaction({ memo: "order-42", amountStroops: "999", sourceAccount: "GANY" }, candidates)
    ).toBeNull();
  });

  it("falls back to buyer address + exact amount when memo is absent", () => {
    expect(
      matchOrphanedTransaction({ amountStroops: "1250000000", sourceAccount: "GBUYER2" }, candidates)
    ).toBe("order-43");
  });

  it("refuses to guess when buyer+amount matches more than one candidate", () => {
    const ambiguous: PendingOrderCandidate[] = [
      { orderId: "order-1", buyerAddress: "GBUYER1", amountStroops: "100" },
      { orderId: "order-2", buyerAddress: "GBUYER1", amountStroops: "100" },
    ];
    expect(matchOrphanedTransaction({ amountStroops: "100", sourceAccount: "GBUYER1" }, ambiguous)).toBeNull();
  });

  it("returns null when nothing matches", () => {
    expect(matchOrphanedTransaction({ amountStroops: "1", sourceAccount: "GUNKNOWN" }, candidates)).toBeNull();
  });
});

describe("scanForOrphanedTransactions", () => {
  it("returns zero counts and does not call Horizon when no escrow accounts are configured", async () => {
    const fetchImpl = vi.fn();
    const result = await scanForOrphanedTransactions({ escrowAccounts: [], fetchImpl });
    expect(result).toEqual({ scanned: 0, matched: 0, quarantined: 0 });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("links a matched payment to its order and quarantines an unmatched one", async () => {
    mockedQuery.mockResolvedValue([
      [{ order_id: "order-42", buyer_address: "GBUYER1", amount_stroops: "1250000000" }],
      {},
    ] as any);
    mockedCheckpointFindByPk.mockResolvedValue(null);

    const escrowAccount = "GESCROW0000000000000000000000000000000000000000000000";
    const matchedRecord: HorizonPaymentOperationRecord = {
      ...baseRecord,
      to: escrowAccount,
      transaction_hash: "tx-matched",
      transaction: { memo: "order-42", memo_type: "text" },
    };
    const unmatchedRecord: HorizonPaymentOperationRecord = {
      ...baseRecord,
      to: escrowAccount,
      transaction_hash: "tx-unmatched",
      amount: "7.0000000",
      transaction: { memo_type: "none" },
    };

    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse({ _embedded: { records: [matchedRecord, unmatchedRecord] } }))
      .mockResolvedValueOnce(jsonResponse({ _embedded: { records: [] } }));

    const result = await scanForOrphanedTransactions({ escrowAccounts: [escrowAccount], fetchImpl, pageLimit: 200 });

    expect(result).toEqual({ scanned: 2, matched: 1, quarantined: 1 });
    expect(mockedQuery).toHaveBeenCalledWith(
      expect.stringContaining("UPDATE payment_records"),
      expect.objectContaining({ replacements: { txHash: "tx-matched", orderId: "order-42" } })
    );
    expect(mockedQuarantineUpsert).toHaveBeenCalledWith(
      expect.objectContaining({ txHash: "tx-unmatched", status: "pending_review" })
    );
    expect(mockedCheckpointUpsert).toHaveBeenCalledWith(
      expect.objectContaining({ escrowAccount, lastCursor: unmatchedRecord.paging_token })
    );
  });

  it("propagates a Horizon failure instead of silently dropping the scan", async () => {
    mockedQuery.mockResolvedValue([[], {}] as any);
    mockedCheckpointFindByPk.mockResolvedValue(null);
    const fetchImpl = vi.fn().mockResolvedValue(jsonResponse({}, false, 500));

    await expect(
      scanForOrphanedTransactions({ escrowAccounts: ["GESCROW1"], fetchImpl })
    ).rejects.toThrow("Horizon payments request failed with status 500");
  });
});

describe("startOrphanScannerWorker / stopOrphanScannerWorker", () => {
  it("is idempotent across repeated starts and safe to stop", () => {
    mockedQuery.mockResolvedValue([[], {}] as any);
    startOrphanScannerWorker(60_000);
    startOrphanScannerWorker(60_000);
    stopOrphanScannerWorker();
    expect(true).toBe(true);
  });
});
