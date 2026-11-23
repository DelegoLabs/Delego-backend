/**
 * Purchase Proposal Generation — Issue #534
 *
 * POST /api/v1/agent/proposals
 *
 * Creates a purchase proposal, computes a canonical SHA-256 hash of its
 * fields, then signs the hash with the agent's Ed25519 key.  The signed
 * proposal is returned for one-click buyer authorization on the frontend.
 */
import { createHash, createPrivateKey, sign as nodeCryptoSign } from "node:crypto";
import { randomUUID } from "node:crypto";
import { Pool } from "pg";
import { createLogger } from "@delegolabs/utils";

const log = createLogger("payments:proposals", process.env.LOG_LEVEL ?? "info");

// ── DB pool (lazy) ───────────────────────────────────────────────────────────

let _pool: Pool | null = null;

function getPool(): Pool {
  if (!_pool) {
    _pool = new Pool({
      connectionString:
        process.env.DATABASE_URL ?? "postgresql://delego:delego@localhost:5432/delego",
    });
  }
  return _pool;
}

export function _setProposalPoolForTesting(p: Pool): void { _pool = p; }
export function _resetProposalPool(): void { _pool = null; }

// ── Types ────────────────────────────────────────────────────────────────────

export interface ProposalItem {
  productId: string;
  quantity: number;
  unitPriceStroops: string;
}

export interface CreateProposalInput {
  agentId: string;
  buyerAddress: string;
  merchantAddress: string;
  items: ProposalItem[];
  totalAmountStroops: string;
  escrowSalt: string;
  expiresAt: string;
}

export interface PurchaseProposalRecord {
  id: string;
  agentId: string;
  buyerAddress: string;
  merchantAddress: string;
  items: ProposalItem[];
  totalAmountStroops: string;
  escrowSalt: string;
  proposalHash: string;
  agentSignature: string;
  expiresAt: string;
  createdAt: string;
}

// ── Canonical hash ───────────────────────────────────────────────────────────

/**
 * Builds a deterministic UTF-8 representation of the proposal fields and
 * returns its SHA-256 hex digest.  Field order is fixed so the same inputs
 * always yield the same hash regardless of JSON serialisation order.
 */
export function computeProposalHash(
  id: string,
  input: CreateProposalInput
): string {
  const canonical = [
    `id=${id}`,
    `agentId=${input.agentId}`,
    `buyerAddress=${input.buyerAddress}`,
    `merchantAddress=${input.merchantAddress}`,
    `totalAmountStroops=${input.totalAmountStroops}`,
    `escrowSalt=${input.escrowSalt}`,
    `expiresAt=${input.expiresAt}`,
    `items=${JSON.stringify(
      input.items.map((it) => ({
        productId: it.productId,
        quantity: it.quantity,
        unitPriceStroops: it.unitPriceStroops,
      }))
    )}`,
  ].join("|");

  return createHash("sha256").update(canonical, "utf8").digest("hex");
}

// ── Ed25519 signing ──────────────────────────────────────────────────────────

/**
 * Signs `hash` with the agent's Ed25519 private key supplied via
 * AGENT_SIGNING_KEY_PEM (a PEM-encoded Ed25519 private key).
 *
 * Returns the hex-encoded 64-byte signature.  When the env variable is absent
 * (local dev / test) a deterministic placeholder is returned instead so
 * downstream code can still exercise the happy path.
 */
function signProposalHash(hash: string): string {
  const pemKey = process.env.AGENT_SIGNING_KEY_PEM;
  if (!pemKey) {
    log.warn("AGENT_SIGNING_KEY_PEM not set — using placeholder signature");
    return createHash("sha256").update(`placeholder:${hash}`).digest("hex");
  }

  try {
    const privateKey = createPrivateKey({ key: pemKey, format: "pem" });
    const signature = nodeCryptoSign(null, Buffer.from(hash, "hex"), privateKey);
    return signature.toString("hex");
  } catch (err) {
    throw new Error(`Failed to sign proposal: ${(err as Error).message}`);
  }
}

// ── Service ──────────────────────────────────────────────────────────────────

export function validateCreateProposalInput(
  raw: Record<string, unknown>
): CreateProposalInput {
  const required = [
    "agentId", "buyerAddress", "merchantAddress",
    "items", "totalAmountStroops", "escrowSalt", "expiresAt",
  ] as const;

  for (const field of required) {
    if (raw[field] === undefined || raw[field] === null || raw[field] === "") {
      throw new Error(`${field} is required`);
    }
  }

  if (!Array.isArray(raw.items) || raw.items.length === 0) {
    throw new Error("items must be a non-empty array");
  }

  const items = (raw.items as unknown[]).map((item, i) => {
    const it = item as Record<string, unknown>;
    if (!it.productId || !it.quantity || !it.unitPriceStroops) {
      throw new Error(`items[${i}] must have productId, quantity, unitPriceStroops`);
    }
    return {
      productId: String(it.productId),
      quantity: Number(it.quantity),
      unitPriceStroops: String(it.unitPriceStroops),
    };
  });

  return {
    agentId: String(raw.agentId),
    buyerAddress: String(raw.buyerAddress),
    merchantAddress: String(raw.merchantAddress),
    items,
    totalAmountStroops: String(raw.totalAmountStroops),
    escrowSalt: String(raw.escrowSalt),
    expiresAt: String(raw.expiresAt),
  };
}

export async function createPurchaseProposal(
  input: CreateProposalInput
): Promise<PurchaseProposalRecord> {
  const id = randomUUID();
  const proposalHash = computeProposalHash(id, input);
  const agentSignature = signProposalHash(proposalHash);

  const { rows } = await getPool().query<{
    id: string;
    agent_id: string;
    buyer_address: string;
    merchant_address: string;
    items: ProposalItem[];
    total_amount_stroops: string;
    escrow_salt: string;
    proposal_hash: string;
    agent_signature: string;
    expires_at: string;
    created_at: string;
  }>(
    `INSERT INTO purchase_proposals
       (id, agent_id, buyer_address, merchant_address, items,
        total_amount_stroops, escrow_salt, proposal_hash, agent_signature,
        expires_at, created_at)
     VALUES ($1,$2,$3,$4,$5::jsonb,$6,$7,$8,$9,$10,NOW())
     RETURNING *`,
    [
      id,
      input.agentId,
      input.buyerAddress,
      input.merchantAddress,
      JSON.stringify(input.items),
      input.totalAmountStroops,
      input.escrowSalt,
      proposalHash,
      agentSignature,
      input.expiresAt,
    ]
  );

  const row = rows[0];
  log.info("Purchase proposal created", { id, agentId: input.agentId });

  return {
    id: row.id,
    agentId: row.agent_id,
    buyerAddress: row.buyer_address,
    merchantAddress: row.merchant_address,
    items: row.items,
    totalAmountStroops: row.total_amount_stroops,
    escrowSalt: row.escrow_salt,
    proposalHash: row.proposal_hash,
    agentSignature: row.agent_signature,
    expiresAt: row.expires_at,
    createdAt: row.created_at,
  };
}
