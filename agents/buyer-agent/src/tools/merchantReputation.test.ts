/**
 * Unit tests for the merchant reputation tool.
 * Issue #264: verifies high-risk flagging, dispute rate calculation,
 * and unregistered merchant handling.
 */

import { describe, it, expect, vi, afterEach } from "vitest";
import { getMerchantReputation, merchantReputationTool } from "./merchantReputation.js";
import { ToolRegistry } from "../../../src/tools/index.js";
import type { AgentContext } from "../../../src/tools/index.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const MERCHANT_ADDRESS = "GXYZ1234";

const READ_CONTEXT: AgentContext = {
  userId: "user-1",
  walletAddress: "GXYZ",
  spendingLimitRemainingStroops: "0",
};

/** Build a base64-encoded JSON payload that parseReputationEntry can decode. */
function encodeEntry(entry: object): string {
  return Buffer.from(JSON.stringify(entry)).toString("base64");
}

function mockFetch(reputationEntry: object | null, marketplaceEntry: object | null) {
  let callCount = 0;
  return vi.fn().mockImplementation(() => {
    callCount++;
    const isReputation = callCount % 2 === 1;
    const entry = isReputation ? reputationEntry : marketplaceEntry;
    const entries = entry ? [{ key: "k", xdr: encodeEntry(entry) }] : [];
    return Promise.resolve({
      ok: true,
      json: () => Promise.resolve({ result: { entries } }),
    });
  });
}

// ---------------------------------------------------------------------------
// getMerchantReputation
// ---------------------------------------------------------------------------

describe("getMerchantReputation", () => {
  afterEach(() => vi.restoreAllMocks());

  it("returns isHighRisk=false for a good merchant (score 80, 2% disputes)", async () => {
    vi.stubGlobal(
      "fetch",
      mockFetch(
        { registered: true, score: 80, completed_escrows: 100, disputes_opened: 2, suspended: false },
        { registered: true, score: 80, completed_escrows: 100, disputes_opened: 0, suspended: false }
      )
    );

    const report = await getMerchantReputation(MERCHANT_ADDRESS);
    expect(report.merchantAddress).toBe(MERCHANT_ADDRESS);
    expect(report.reputationScore).toBe(80);
    expect(report.disputeRatePercent).toBe(2);
    expect(report.isHighRisk).toBe(false);
    expect(report.isRegisteredOnChain).toBe(true);
    expect(report.isSuspended).toBe(false);
  });

  it("flags isHighRisk=true when dispute rate > 5%", async () => {
    vi.stubGlobal(
      "fetch",
      mockFetch(
        { registered: true, score: 75, completed_escrows: 100, disputes_opened: 6, suspended: false },
        null
      )
    );

    const report = await getMerchantReputation(MERCHANT_ADDRESS);
    expect(report.disputeRatePercent).toBe(6);
    expect(report.isHighRisk).toBe(true);
  });

  it("flags isHighRisk=true when score < 60 regardless of dispute rate", async () => {
    vi.stubGlobal(
      "fetch",
      mockFetch(
        { registered: true, score: 45, completed_escrows: 100, disputes_opened: 1, suspended: false },
        null
      )
    );

    const report = await getMerchantReputation(MERCHANT_ADDRESS);
    expect(report.reputationScore).toBe(45);
    expect(report.isHighRisk).toBe(true);
  });

  it("handles unregistered merchant with zero-value defaults", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: true,
        json: () => Promise.resolve({ result: { entries: [] } }),
      })
    );

    const report = await getMerchantReputation(MERCHANT_ADDRESS);
    expect(report.isRegisteredOnChain).toBe(false);
    expect(report.reputationScore).toBe(0);
    expect(report.isHighRisk).toBe(true); // score 0 < 60
  });

  it("reports isSuspended=true from marketplace contract entry", async () => {
    vi.stubGlobal(
      "fetch",
      mockFetch(
        { registered: true, score: 70, completed_escrows: 50, disputes_opened: 1, suspended: false },
        { registered: true, score: 70, completed_escrows: 0, disputes_opened: 0, suspended: true }
      )
    );

    const report = await getMerchantReputation(MERCHANT_ADDRESS);
    expect(report.isSuspended).toBe(true);
  });

  it("calculates 0% dispute rate when no escrows completed", async () => {
    vi.stubGlobal(
      "fetch",
      mockFetch(
        { registered: true, score: 90, completed_escrows: 0, disputes_opened: 0, suspended: false },
        null
      )
    );

    const report = await getMerchantReputation(MERCHANT_ADDRESS);
    expect(report.disputeRatePercent).toBe(0);
  });

  it("throws when the RPC returns a non-200 status", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({ ok: false, status: 503, json: () => Promise.resolve({}) })
    );

    await expect(getMerchantReputation(MERCHANT_ADDRESS)).rejects.toThrow("Soroban RPC error");
  });
});

// ---------------------------------------------------------------------------
// AgentTool integration
// ---------------------------------------------------------------------------

describe("merchantReputationTool via ToolRegistry", () => {
  afterEach(() => vi.restoreAllMocks());

  it("registers and executes via the ToolRegistry", async () => {
    vi.stubGlobal(
      "fetch",
      mockFetch(
        { registered: true, score: 65, completed_escrows: 40, disputes_opened: 1, suspended: false },
        null
      )
    );

    const registry = new ToolRegistry();
    registry.register(merchantReputationTool);

    const result = await registry.execute(
      "get_merchant_reputation",
      { merchantAddress: MERCHANT_ADDRESS },
      READ_CONTEXT
    ) as { isHighRisk: boolean; reputationScore: number };

    expect(result.reputationScore).toBe(65);
    expect(result.isHighRisk).toBe(false); // 65 >= 60 and 2.5% < 5%
  });

  it("rejects empty merchantAddress via Zod validation", async () => {
    const registry = new ToolRegistry();
    registry.register(merchantReputationTool);

    await expect(
      registry.execute("get_merchant_reputation", { merchantAddress: "" }, READ_CONTEXT)
    ).rejects.toThrow();
  });
});
