/**
 * On-Chain Merchant Reputation & Verification Tool.
 * Issue #264: queries the delego-reputation and delego-marketplace Soroban
 * contracts for merchant reliability data before an order is proposed.
 *
 * Scope: agents/buyer-agent/src/tools/merchantReputation.ts
 */

import { z } from "zod";
import type { AgentTool, AgentContext } from "../../../src/tools/index.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface MerchantReputationReport {
  merchantAddress: string;
  isRegisteredOnChain: boolean;
  reputationScore: number; // 0 – 100
  totalCompletedEscrows: number;
  totalDisputesOpened: number;
  disputeRatePercent: number;
  isSuspended: boolean;
  /** Set to true when dispute rate > 5% OR reputationScore < 60 */
  isHighRisk: boolean;
}

// ---------------------------------------------------------------------------
// Soroban RPC helpers
// ---------------------------------------------------------------------------

const SOROBAN_RPC_URL =
  process.env["SOROBAN_RPC_URL"] ?? "https://soroban-testnet.stellar.org";
const REPUTATION_CONTRACT_ID = process.env["REPUTATION_CONTRACT_ID"] ?? "";
const MARKETPLACE_CONTRACT_ID = process.env["MARKETPLACE_CONTRACT_ID"] ?? "";

interface SorobanRpcResponse {
  result?: {
    xdr?: string;
    entries?: Array<{
      key: string;
      xdr: string;
    }>;
  };
  error?: { message?: string };
}

/**
 * Minimal Soroban RPC call — getLedgerEntries for a contract storage key.
 * We derive the key from the merchant address using the contract's storage schema.
 */
async function sorobanGetLedgerEntries(
  contractId: string,
  keyXdr: string
): Promise<SorobanRpcResponse> {
  const body = {
    jsonrpc: "2.0",
    id: 1,
    method: "getLedgerEntries",
    params: {
      keys: [keyXdr],
    },
  };

  const res = await fetch(SOROBAN_RPC_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });

  if (!res.ok) {
    throw new Error(
      `Soroban RPC error ${res.status} for contract ${contractId}`
    );
  }

  return (await res.json()) as SorobanRpcResponse;
}

// ---------------------------------------------------------------------------
// Contract query helpers
// ---------------------------------------------------------------------------

/**
 * Derive the XDR ledger key for a merchant address in the given contract.
 * The key is contract + symbol("Merchant") + address in XDR form.
 *
 * NOTE: In production this should use @stellar/stellar-sdk to build the XDR
 * properly. Here we use a simplified base64-encoding pattern that works for
 * testnet simulation and keeps the tool free of heavy SDK dependencies.
 */
function buildMerchantKey(contractId: string, merchantAddress: string): string {
  // Encode as a simple JSON key that the Soroban RPC can look up.
  // Real implementation: xdr.ScVal.scvLedgerKeyContractInstance(...)
  const payload = JSON.stringify({ contract: contractId, key: "merchant", address: merchantAddress });
  return Buffer.from(payload).toString("base64");
}

interface ReputationEntry {
  registered: boolean;
  score: number;
  completed_escrows: number;
  disputes_opened: number;
  suspended: boolean;
}

/** Parse the Soroban XDR response into a structured reputation entry. */
function parseReputationEntry(response: SorobanRpcResponse): ReputationEntry | null {
  // In a real implementation, decode response.result.entries[0].xdr using stellar-sdk.
  // For the sandbox/testnet, we expect the RPC to return a JSON-serialised XDR value
  // or we receive no entries (merchant not registered).
  const entries = response.result?.entries;
  if (!entries || entries.length === 0) return null;

  try {
    const decoded = Buffer.from(entries[0].xdr, "base64").toString("utf-8");
    return JSON.parse(decoded) as ReputationEntry;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Core query function
// ---------------------------------------------------------------------------

/**
 * Query on-chain reputation for a merchant address.
 * Combines data from the reputation contract (score, disputes) and the
 * marketplace contract (registration, suspension status).
 */
export async function getMerchantReputation(
  merchantAddress: string
): Promise<MerchantReputationReport> {
  const reputationKey = buildMerchantKey(REPUTATION_CONTRACT_ID, merchantAddress);
  const marketplaceKey = buildMerchantKey(MARKETPLACE_CONTRACT_ID, merchantAddress);

  const [reputationResponse, marketplaceResponse] = await Promise.all([
    sorobanGetLedgerEntries(REPUTATION_CONTRACT_ID, reputationKey),
    sorobanGetLedgerEntries(MARKETPLACE_CONTRACT_ID, marketplaceKey),
  ]);

  const reputationEntry = parseReputationEntry(reputationResponse);
  const marketplaceEntry = parseReputationEntry(marketplaceResponse);

  // Defaults when merchant is not registered on-chain
  const isRegisteredOnChain = !!(reputationEntry || marketplaceEntry);
  const reputationScore = reputationEntry?.score ?? 0;
  const totalCompletedEscrows = reputationEntry?.completed_escrows ?? 0;
  const totalDisputesOpened = reputationEntry?.disputes_opened ?? 0;
  const isSuspended = marketplaceEntry?.suspended ?? false;

  const disputeRatePercent =
    totalCompletedEscrows > 0
      ? (totalDisputesOpened / totalCompletedEscrows) * 100
      : 0;

  // High-risk flag: dispute rate > 5% OR reputation score < 60
  const isHighRisk = disputeRatePercent > 5 || reputationScore < 60;

  return {
    merchantAddress,
    isRegisteredOnChain,
    reputationScore,
    totalCompletedEscrows,
    totalDisputesOpened,
    disputeRatePercent: Math.round(disputeRatePercent * 100) / 100,
    isSuspended,
    isHighRisk,
  };
}

// ---------------------------------------------------------------------------
// AgentTool definition
// ---------------------------------------------------------------------------

const inputSchema = z.object({
  merchantAddress: z.string().min(1, "merchantAddress is required"),
});

type Input = z.infer<typeof inputSchema>;

/**
 * Agent tool wrapping getMerchantReputation.
 * Requires only "read_only" permission since it only reads on-chain state.
 */
export const merchantReputationTool: AgentTool<Input, MerchantReputationReport> = {
  name: "get_merchant_reputation",
  description:
    "Query on-chain merchant reputation and registration status from the Soroban " +
    "delego-reputation and delego-marketplace contracts. Returns a high-risk flag " +
    "when the dispute rate exceeds 5% or the reputation score is below 60.",
  inputSchema,
  requiredPermission: "read_only",
  execute: async (input: Input, _context: AgentContext) => {
    return getMerchantReputation(input.merchantAddress);
  },
};
