import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Pool } from "pg";
import { escrowCoordinator } from "../escrowCoordinator/index.js";
import { getEscrowContractId } from "../../escrow/config.js";
import {
  _resetPoolForTesting,
  _setPoolForTesting,
  findExpiredEscrows,
  getCurrentLedger,
  processTimeoutRefund,
  runTimeoutRefundSweep,
  startTimeoutRefundScheduler,
  type ExpiredEscrowCheck,
} from "./timeoutRefund.js";

vi.mock("../escrowCoordinator/index.js", () => ({
  escrowCoordinator: {
    getEscrowStatus: vi.fn(),
    refundEscrow: vi.fn(),
  },
}));

vi.mock("../../escrow/config.js", () => ({
  getEscrowContractId: vi.fn(() => "CCONTRACT123"),
}));

const sampleCheck = (
  overrides: Partial<ExpiredEscrowCheck> = {}
): ExpiredEscrowCheck => ({
  escrowId: "escrow-1",
  orderId: "order-1",
  buyerAddress: "GBUYERADDRESS",
  timeoutLedger: 1000,
  currentLedger: 1050,
  ...overrides,
});

describe("timeoutRefund worker", () => {
  const originalEnv = { ...process.env };

  beforeEach(() => {
    vi.clearAllMocks();
    _resetPoolForTesting();
    delete process.env.SOROBAN_CURRENT_LEDGER_OVERRIDE;
    delete process.env.STELLAR_HORIZON_URL;
    delete process.env.ESCROW_AUTO_RELEASE_CALLER_ADDRESS;
    delete process.env.ESCROW_TIMEOUT_REFUND_CALLER_ADDRESS;
    delete process.env.TIMEOUT_REFUND_INTERVAL_SECONDS;
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.useRealTimers();
    _resetPoolForTesting();
    process.env = { ...originalEnv };
  });

  describe("getCurrentLedger", () => {
    it("returns SOROBAN_CURRENT_LEDGER_OVERRIDE when valid", async () => {
      process.env.SOROBAN_CURRENT_LEDGER_OVERRIDE = "42000";
      const fetchMock = vi.fn();
      vi.stubGlobal("fetch", fetchMock);

      await expect(getCurrentLedger()).resolves.toBe(42000);
      expect(fetchMock).not.toHaveBeenCalled();
    });

    it("ignores non-positive or invalid override and fetches from Horizon", async () => {
      process.env.SOROBAN_CURRENT_LEDGER_OVERRIDE = "0";
      process.env.STELLAR_HORIZON_URL = "https://horizon.example.org";
      const fetchMock = vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({ _embedded: { records: [{ sequence: 55000 }] } }),
      });
      vi.stubGlobal("fetch", fetchMock);

      await expect(getCurrentLedger()).resolves.toBe(55000);
      expect(fetchMock).toHaveBeenCalledWith(
        "https://horizon.example.org/ledgers?order=desc&limit=1"
      );
    });

    it("throws when Horizon returns a non-OK status", async () => {
      vi.stubGlobal(
        "fetch",
        vi.fn().mockResolvedValue({ ok: false, status: 503 })
      );

      await expect(getCurrentLedger()).rejects.toThrow(
        "Cannot determine current ledger: Horizon returned 503"
      );
    });

    it("throws when Horizon response shape is unexpected", async () => {
      vi.stubGlobal(
        "fetch",
        vi.fn().mockResolvedValue({
          ok: true,
          json: async () => ({ _embedded: { records: [{}] } }),
        })
      );

      await expect(getCurrentLedger()).rejects.toThrow(
        "Cannot determine current ledger: Unexpected Horizon response shape"
      );
    });
  });

  describe("findExpiredEscrows", () => {
    it("queries funded expired escrows and maps rows to ExpiredEscrowCheck", async () => {
      const query = vi.fn().mockResolvedValue({
        rows: [
          {
            escrow_id: "escrow-1",
            order_id: "order-1",
            buyer_address: "GBUYER1",
            timeout_ledger: 900,
          },
          {
            escrow_id: "escrow-2",
            order_id: "order-2",
            buyer_address: "GBUYER2",
            timeout_ledger: 1000,
          },
        ],
      });
      _setPoolForTesting({ query } as unknown as Pool);

      const expired = await findExpiredEscrows(1000);

      expect(query).toHaveBeenCalledOnce();
      expect(query.mock.calls[0][1]).toEqual([1000]);
      expect(expired).toEqual([
        {
          escrowId: "escrow-1",
          orderId: "order-1",
          buyerAddress: "GBUYER1",
          timeoutLedger: 900,
          currentLedger: 1000,
        },
        {
          escrowId: "escrow-2",
          orderId: "order-2",
          buyerAddress: "GBUYER2",
          timeoutLedger: 1000,
          currentLedger: 1000,
        },
      ]);
    });

    it("returns an empty array when no escrows are expired", async () => {
      const query = vi.fn().mockResolvedValue({ rows: [] });
      _setPoolForTesting({ query } as unknown as Pool);

      await expect(findExpiredEscrows(1000)).resolves.toEqual([]);
    });
  });

  describe("processTimeoutRefund", () => {
    it("triggers refund for a funded expired escrow", async () => {
      vi.mocked(escrowCoordinator.getEscrowStatus).mockResolvedValueOnce({
        escrowId: "escrow-1",
        buyer: "GBUYERADDRESS",
        seller: "GSELLERADDRESS",
        amount: "1000",
        status: "funded",
        createdAt: 0,
      });
      vi.mocked(escrowCoordinator.refundEscrow).mockResolvedValueOnce({
        escrowId: "escrow-1",
        status: "refunded",
        txHash: "tx-hash-123",
      });

      const result = await processTimeoutRefund(
        sampleCheck(),
        "GCALLER",
        "CCONTRACT123"
      );

      expect(result).toEqual({
        escrowId: "escrow-1",
        orderId: "order-1",
        status: "refunded",
        txHash: "tx-hash-123",
      });
      expect(escrowCoordinator.refundEscrow).toHaveBeenCalledWith({
        escrowId: "escrow-1",
        escrowContractId: "CCONTRACT123",
        callerAddress: "GCALLER",
        reason: "timeout",
      });
    });

    it("skips refund idempotently when escrow is already refunded on-chain", async () => {
      vi.mocked(escrowCoordinator.getEscrowStatus).mockResolvedValueOnce({
        escrowId: "escrow-1",
        buyer: "GBUYERADDRESS",
        seller: "GSELLERADDRESS",
        amount: "1000",
        status: "refunded",
        createdAt: 0,
      });

      const result = await processTimeoutRefund(
        sampleCheck(),
        "GCALLER",
        "CCONTRACT123"
      );

      expect(result).toEqual({
        escrowId: "escrow-1",
        orderId: "order-1",
        status: "skipped",
        reason: "Escrow already refunded; no refund needed",
      });
      expect(escrowCoordinator.refundEscrow).not.toHaveBeenCalled();
    });

    it("skips refund idempotently when escrow is already released on-chain", async () => {
      vi.mocked(escrowCoordinator.getEscrowStatus).mockResolvedValueOnce({
        escrowId: "escrow-1",
        buyer: "GBUYERADDRESS",
        seller: "GSELLERADDRESS",
        amount: "1000",
        status: "released",
        createdAt: 0,
      });

      const result = await processTimeoutRefund(
        sampleCheck(),
        "GCALLER",
        "CCONTRACT123"
      );

      expect(result).toEqual({
        escrowId: "escrow-1",
        orderId: "order-1",
        status: "skipped",
        reason: "Escrow already released; no refund needed",
      });
      expect(escrowCoordinator.refundEscrow).not.toHaveBeenCalled();
    });

    it("skips refund when escrow is disputed on-chain", async () => {
      vi.mocked(escrowCoordinator.getEscrowStatus).mockResolvedValueOnce({
        escrowId: "escrow-1",
        buyer: "GBUYERADDRESS",
        seller: "GSELLERADDRESS",
        amount: "1000",
        status: "disputed",
        createdAt: 0,
      });

      const result = await processTimeoutRefund(
        sampleCheck(),
        "GCALLER",
        "CCONTRACT123"
      );

      expect(result).toEqual({
        escrowId: "escrow-1",
        orderId: "order-1",
        status: "skipped",
        reason: "Escrow is disputed; timeout refund skipped",
      });
      expect(escrowCoordinator.refundEscrow).not.toHaveBeenCalled();
    });

    it("skips refund when on-chain status cannot be fetched", async () => {
      vi.mocked(escrowCoordinator.getEscrowStatus).mockRejectedValueOnce(
        new Error("RPC timeout")
      );

      const result = await processTimeoutRefund(
        sampleCheck(),
        "GCALLER",
        "CCONTRACT123"
      );

      expect(result).toEqual({
        escrowId: "escrow-1",
        orderId: "order-1",
        status: "skipped",
        reason: "Could not verify on-chain status: RPC timeout",
      });
      expect(escrowCoordinator.refundEscrow).not.toHaveBeenCalled();
    });

    it("returns failed when refundEscrow returns a non-refunded status", async () => {
      vi.mocked(escrowCoordinator.getEscrowStatus).mockResolvedValueOnce({
        escrowId: "escrow-1",
        buyer: "GBUYERADDRESS",
        seller: "GSELLERADDRESS",
        amount: "1000",
        status: "funded",
        createdAt: 0,
      });
      vi.mocked(escrowCoordinator.refundEscrow).mockResolvedValueOnce({
        escrowId: "escrow-1",
        status: "failed",
        txHash: "",
      } as never);

      const result = await processTimeoutRefund(
        sampleCheck(),
        "GCALLER",
        "CCONTRACT123"
      );

      expect(result).toEqual({
        escrowId: "escrow-1",
        orderId: "order-1",
        status: "failed",
        reason: "Refund transaction did not succeed on-chain",
      });
    });

    it("returns failed when refundEscrow throws an error", async () => {
      vi.mocked(escrowCoordinator.getEscrowStatus).mockResolvedValueOnce({
        escrowId: "escrow-1",
        buyer: "GBUYERADDRESS",
        seller: "GSELLERADDRESS",
        amount: "1000",
        status: "funded",
        createdAt: 0,
      });
      vi.mocked(escrowCoordinator.refundEscrow).mockRejectedValueOnce(
        new Error("Soroban tx rejected")
      );

      const result = await processTimeoutRefund(
        sampleCheck(),
        "GCALLER",
        "CCONTRACT123"
      );

      expect(result).toEqual({
        escrowId: "escrow-1",
        orderId: "order-1",
        status: "failed",
        reason: "Soroban tx rejected",
      });
    });
  });

  describe("runTimeoutRefundSweep", () => {
    it("throws when no caller address is provided or configured", async () => {
      await expect(runTimeoutRefundSweep()).rejects.toThrow(
        "ESCROW_AUTO_RELEASE_CALLER_ADDRESS or ESCROW_TIMEOUT_REFUND_CALLER_ADDRESS must be set for timeout refunds"
      );
    });

    it("aggregates refunded, skipped, and failed results across expired escrows", async () => {
      process.env.SOROBAN_CURRENT_LEDGER_OVERRIDE = "2000";
      process.env.ESCROW_TIMEOUT_REFUND_CALLER_ADDRESS = "GCALLER_ENV";

      const query = vi.fn().mockResolvedValue({
        rows: [
          {
            escrow_id: "escrow-refund",
            order_id: "order-1",
            buyer_address: "GBUYER1",
            timeout_ledger: 1500,
          },
          {
            escrow_id: "escrow-disputed",
            order_id: "order-2",
            buyer_address: "GBUYER2",
            timeout_ledger: 1600,
          },
          {
            escrow_id: "escrow-fail",
            order_id: "order-3",
            buyer_address: "GBUYER3",
            timeout_ledger: 1700,
          },
        ],
      });
      _setPoolForTesting({ query } as unknown as Pool);

      vi.mocked(escrowCoordinator.getEscrowStatus)
        .mockResolvedValueOnce({
          escrowId: "escrow-refund",
          buyer: "GBUYER1",
          seller: "GSELLER1",
          amount: "500",
          status: "funded",
          createdAt: 0,
        })
        .mockResolvedValueOnce({
          escrowId: "escrow-disputed",
          buyer: "GBUYER2",
          seller: "GSELLER2",
          amount: "500",
          status: "disputed",
          createdAt: 0,
        })
        .mockResolvedValueOnce({
          escrowId: "escrow-fail",
          buyer: "GBUYER3",
          seller: "GSELLER3",
          amount: "500",
          status: "funded",
          createdAt: 0,
        });

      vi.mocked(escrowCoordinator.refundEscrow)
        .mockResolvedValueOnce({
          escrowId: "escrow-refund",
          status: "refunded",
          txHash: "tx-1",
        })
        .mockRejectedValueOnce(new Error("insufficient fee"));

      const sweep = await runTimeoutRefundSweep();

      expect(getEscrowContractId).toHaveBeenCalled();
      expect(sweep.checked).toBe(3);
      expect(sweep.refunded).toBe(1);
      expect(sweep.skipped).toBe(1);
      expect(sweep.failed).toBe(1);
      expect(sweep.results).toEqual([
        {
          escrowId: "escrow-refund",
          orderId: "order-1",
          status: "refunded",
          txHash: "tx-1",
        },
        {
          escrowId: "escrow-disputed",
          orderId: "order-2",
          status: "skipped",
          reason: "Escrow is disputed; timeout refund skipped",
        },
        {
          escrowId: "escrow-fail",
          orderId: "order-3",
          status: "failed",
          reason: "insufficient fee",
        },
      ]);
    });

    it("is idempotent across repeated sweeps when an escrow becomes refunded on-chain", async () => {
      process.env.SOROBAN_CURRENT_LEDGER_OVERRIDE = "2000";

      const query = vi.fn().mockResolvedValue({
        rows: [
          {
            escrow_id: "escrow-1",
            order_id: "order-1",
            buyer_address: "GBUYER1",
            timeout_ledger: 1500,
          },
        ],
      });
      _setPoolForTesting({ query } as unknown as Pool);

      vi.mocked(escrowCoordinator.getEscrowStatus)
        .mockResolvedValueOnce({
          escrowId: "escrow-1",
          buyer: "GBUYER1",
          seller: "GSELLER1",
          amount: "500",
          status: "funded",
          createdAt: 0,
        })
        .mockResolvedValueOnce({
          escrowId: "escrow-1",
          buyer: "GBUYER1",
          seller: "GSELLER1",
          amount: "500",
          status: "refunded",
          createdAt: 0,
        });

      vi.mocked(escrowCoordinator.refundEscrow).mockResolvedValueOnce({
        escrowId: "escrow-1",
        status: "refunded",
        txHash: "tx-once",
      });

      const firstSweep = await runTimeoutRefundSweep("GCALLER");
      const secondSweep = await runTimeoutRefundSweep("GCALLER");

      expect(firstSweep.refunded).toBe(1);
      expect(firstSweep.skipped).toBe(0);
      expect(secondSweep.refunded).toBe(0);
      expect(secondSweep.skipped).toBe(1);
      expect(escrowCoordinator.refundEscrow).toHaveBeenCalledTimes(1);
    });
  });

  describe("startTimeoutRefundScheduler", () => {
    it("does not run sweeps when TIMEOUT_REFUND_INTERVAL_SECONDS is 0", () => {
      process.env.TIMEOUT_REFUND_INTERVAL_SECONDS = "0";
      const query = vi.fn();
      _setPoolForTesting({ query } as unknown as Pool);

      const handle = startTimeoutRefundScheduler("GCALLER");
      handle.stop();

      expect(query).not.toHaveBeenCalled();
    });

    it("runs immediately and on interval until stopped", async () => {
      vi.useFakeTimers();
      process.env.TIMEOUT_REFUND_INTERVAL_SECONDS = "60";
      process.env.SOROBAN_CURRENT_LEDGER_OVERRIDE = "2000";

      const query = vi.fn().mockResolvedValue({ rows: [] });
      _setPoolForTesting({ query } as unknown as Pool);

      const handle = startTimeoutRefundScheduler("GCALLER");
      await vi.advanceTimersByTimeAsync(0);
      expect(query).toHaveBeenCalledTimes(1);

      await vi.advanceTimersByTimeAsync(60_000);
      expect(query).toHaveBeenCalledTimes(2);

      handle.stop();
      await vi.advanceTimersByTimeAsync(120_000);
      expect(query).toHaveBeenCalledTimes(2);
    });
  });
});
