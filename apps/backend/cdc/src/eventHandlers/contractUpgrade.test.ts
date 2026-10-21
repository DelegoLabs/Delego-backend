/**
 * Tests for Contract Upgrade Event Listener (Issue #603)
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { ContractUpgradeListener, createContractUpgradeListener } from "./contractUpgrade.js";

// Mock dependencies with simple functions
const mockPgPool = {
  query: vi.fn().mockResolvedValue({ rows: [] }),
  connect: vi.fn(),
  end: vi.fn(),
};

const mockRedis = {
  xreadgroup: vi.fn().mockResolvedValue(null),
  xgroup: vi.fn().mockResolvedValue("OK"),
  xack: vi.fn().mockResolvedValue(1),
  pipeline: vi.fn(() => ({
    xadd: vi.fn(),
    exec: vi.fn(),
  })),
  quit: vi.fn(),
};

const mockLogger = {
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
  debug: vi.fn(),
};

describe("ContractUpgradeListener", () => {
  let listener: ContractUpgradeListener;

  beforeEach(() => {
    vi.clearAllMocks();

    // Setup default mock responses
    mockPgPool.query.mockResolvedValue({ rows: [] });
    mockRedis.xreadgroup.mockResolvedValue(null);
    mockRedis.xgroup.mockResolvedValue("OK");
    mockRedis.xack.mockResolvedValue(1);

    listener = new ContractUpgradeListener({
      redis: mockRedis as any,
      pgPool: mockPgPool as any,
      monitoredContracts: ["CAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAH"],
      initialApprovedHashes: [
        {
          contractAddress: "CAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAH",
          wasmHash: "abc123",
          approvedBy: "GABC...MULTISIG",
          approvedAt: "2024-01-01T00:00:00Z",
          description: "Initial deployment",
        },
      ],
      logger: mockLogger as any,
    });
  });

  afterEach(() => {
    listener.stop();
  });

  describe("Approved Hash Management", () => {
    it("should initialize with provided approved hashes", () => {
      expect(listener.isApproved("CAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAH", "abc123")).toBe(true);
      expect(listener.isApproved("CAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAH", "def456")).toBe(false);
    });

    it("should add approved hashes at runtime", async () => {
      await listener.addApprovedHash({
        contractAddress: "CAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAH",
        wasmHash: "def456",
        approvedBy: "GABC...MULTISIG",
        approvedAt: "2024-01-02T00:00:00Z",
        description: "v2.0.0 upgrade",
      });

      expect(listener.isApproved("CAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAH", "def456")).toBe(true);
      expect(mockPgPool.query).toHaveBeenCalled();
    });

    it("should remove approved hashes", async () => {
      await listener.removeApprovedHash("CAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAH", "abc123");

      expect(listener.isApproved("CAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAH", "abc123")).toBe(false);
      expect(mockPgPool.query).toHaveBeenCalled();
    });

    it("should return approved hashes for a contract", () => {
      const hashes = listener.getApprovedHashes("CAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAH");
      expect(hashes).toHaveLength(1);
      expect(hashes[0].wasmHash).toBe("abc123");
    });
  });

  describe("Verified Upgrade Handling", () => {
    it("should update contract config for verified upgrades", async () => {
      const event = {
        contractAddress: "CAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAH",
        oldWasmHash: "abc123",
        newWasmHash: "abc123", // Same as approved
        executedBy: "GABC...EXECUTOR",
        ledgerSequence: 1000,
        timestamp: "2024-01-01T12:00:00Z",
        txHash: "tx-123",
        eventId: "evt-123",
      };

      await (listener as any).handleVerifiedUpgrade(event);

      expect(mockPgPool.query).toHaveBeenCalledWith(
        expect.stringContaining("INSERT INTO contract_config_records"),
        expect.arrayContaining([
          event.contractAddress,
          event.newWasmHash,
          event.ledgerSequence,
          event.txHash,
          event.timestamp,
        ])
      );
    });
  });

  describe("Unverified Upgrade Handling", () => {
    it("should pause withdrawals for unverified upgrades", async () => {
      const event = {
        contractAddress: "CAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAH",
        oldWasmHash: "abc123",
        newWasmHash: "unverified-hash",
        executedBy: "GABC...EXECUTOR",
        ledgerSequence: 1000,
        timestamp: "2024-01-01T12:00:00Z",
        txHash: "tx-123",
        eventId: "evt-123",
      };

      await (listener as any).handleUnverifiedUpgrade(event);

      // Should pause withdrawals
      const pauseCall = mockPgPool.query.mock.calls.find((call) =>
        (call[0] as string).includes("INSERT INTO contract_withdrawal_pause_state")
      );
      expect(pauseCall).toBeDefined();
      const pauseArgs = pauseCall?.[1] as unknown[];
      expect(pauseArgs).toContain(event.contractAddress);
      expect(pauseArgs.some((arg) => typeof arg === "string" && arg.includes("Unverified WASM hash"))).toBe(true);

      // Should update contract status to quarantined
      const statusCall = mockPgPool.query.mock.calls.find((call) =>
        (call[0] as string).includes("UPDATE contract_config_records SET status")
      );
      expect(statusCall).toBeDefined();
      const statusArgs = statusCall?.[1] as unknown[];
      expect(statusArgs).toContain(event.contractAddress);
      expect(statusArgs).toContain("quarantined");
    });
  });

  describe("Withdrawal Pause State", () => {
    it("should check if withdrawals are paused", async () => {
      mockPgPool.query.mockResolvedValueOnce({
        rows: [{
          contract_address: "CAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAH",
          paused: true,
          paused_at: new Date(),
          paused_by: "contractUpgradeListener",
          pause_reason: "Unverified upgrade",
          resumed_at: null,
          resumed_by: null,
        }],
      });

      const paused = await listener.areWithdrawalsPaused("CAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAH");
      expect(paused).toBe(true);
    });

    it("should return false when not paused", async () => {
      mockPgPool.query.mockResolvedValueOnce({ rows: [] });

      const paused = await listener.areWithdrawalsPaused("CAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAH");
      expect(paused).toBe(false);
    });

    it("should resume withdrawals", async () => {
      await listener.resumeWithdrawals(
        "CAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAH",
        "governance",
        "Verified by multisig"
      );

      expect(mockPgPool.query).toHaveBeenCalledWith(
        expect.stringContaining("UPDATE contract_withdrawal_pause_state"),
        expect.arrayContaining([
          "CAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAH",
          "governance",
        ])
      );
    });
  });

  describe("Status Reporting", () => {
    it("should return current status", () => {
      const status = listener.getStatus();

      expect(status.running).toBe(false);
      expect(status.monitoredContracts).toContain("CAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAH");
      expect(status.approvedHashesCount).toBe(1);
    });
  });
});

describe("createContractUpgradeListener factory", () => {
  it("should create listener with default options", async () => {
    const listener = await createContractUpgradeListener({
      redis: mockRedis as any,
      pgPool: mockPgPool as any,
      monitoredContracts: ["CAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAH"],
    });

    expect(listener).toBeInstanceOf(ContractUpgradeListener);
    listener.stop();
  });
});