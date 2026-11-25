/**
 * Partial Refund Dispute Settlement Negotiation State Machine (Issue #504).
 *
 * Manages the lifecycle of a PartialRefundOffer:
 *   proposed → countered → accepted → Soroban split disbursement
 *                        → expired
 *
 * Arithmetic invariant: buyerRefundStroops + merchantPayoutStroops === totalOrderStroops.
 * Both parties must sign before disbursement is dispatched.
 */

import { randomUUID } from "node:crypto";
import { Pool, type QueryResultRow } from "pg";
import { createLogger } from "@delegolabs/utils";
import { escrowCoordinator } from "../escrowCoordinator/index.js";
import { getEscrowContractId } from "../../escrow/config.js";
import { publishPaymentEvent } from "../../events/index.js";

const log = createLogger("payments:disputes:partial-refund-negotiation", process.env.LOG_LEVEL ?? "info");

// ---------------------------------------------------------------------------
// Types (from issue spec)
// ---------------------------------------------------------------------------

export interface PartialRefundOffer {
  proposalId: string;
  orderId: string;
  escrowId: string;
  totalOrderStroops: string;
  proposerRole: "buyer" | "merchant";
  buyerRefundStroops: string;
  merchantPayoutStroops: string;
  status: "proposed" | "countered" | "accepted" | "expired";
  buyerSignature?: string;
  merchantSignature?: string;
  expiresAt: string;
  createdAt: string;
  updatedAt: string;
}

export interface CreatePartialRefundOfferInput {
  orderId: string; escrowId: string; totalOrderStroops: string;
  proposerRole: "buyer" | "merchant";
  buyerRefundStroops: string; merchantPayoutStroops: string;
  signature: string; expiresAt?: string;
}

export interface CounterOfferInput { buyerRefundStroops: string; merchantPayoutStroops: string; signature: string; }
export interface SignOfferInput { role: "buyer" | "merchant"; signature: string; }

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

export class ArithmeticImbalanceError extends Error {
  constructor(b: string, m: string, t: string) {
    super(`buyerRefundStroops (${b}) + merchantPayoutStroops (${m}) must equal totalOrderStroops (${t})`);
    this.name = "ArithmeticImbalanceError";
  }
}
export class ProposalNotFoundError extends Error {
  constructor(public readonly proposalId: string) { super(`Partial refund proposal ${proposalId} not found`); this.name = "ProposalNotFoundError"; }
}
export class ProposalNotOpenError extends Error {
  constructor(public readonly proposalId: string, public readonly status: string) {
    super(`Proposal ${proposalId} is '${status}' and cannot be modified`); this.name = "ProposalNotOpenError";
  }
}

// ---------------------------------------------------------------------------
// Store interface + in-memory implementation
// ---------------------------------------------------------------------------

export interface PartialRefundProposalStore {
  create(input: CreatePartialRefundOfferInput): Promise<PartialRefundOffer>;
  findById(id: string): Promise<PartialRefundOffer | null>;
  findByOrderId(orderId: string): Promise<PartialRefundOffer[]>;
  update(id: string, patch: Partial<PartialRefundOffer>): Promise<PartialRefundOffer>;
}

export class InMemoryPartialRefundProposalStore implements PartialRefundProposalStore {
  private readonly m = new Map<string, PartialRefundOffer>();
  async create(input: CreatePartialRefundOfferInput): Promise<PartialRefundOffer> {
    assertBalance(input.buyerRefundStroops, input.merchantPayoutStroops, input.totalOrderStroops);
    const now = new Date().toISOString();
    const p: PartialRefundOffer = {
      proposalId: randomUUID(), orderId: input.orderId, escrowId: input.escrowId,
      totalOrderStroops: input.totalOrderStroops, proposerRole: input.proposerRole,
      buyerRefundStroops: input.buyerRefundStroops, merchantPayoutStroops: input.merchantPayoutStroops,
      status: "proposed",
      buyerSignature: input.proposerRole === "buyer" ? input.signature : undefined,
      merchantSignature: input.proposerRole === "merchant" ? input.signature : undefined,
      expiresAt: input.expiresAt ?? new Date(Date.now() + 48 * 3600_000).toISOString(),
      createdAt: now, updatedAt: now,
    };
    this.m.set(p.proposalId, p);
    return { ...p };
  }
  async findById(id: string): Promise<PartialRefundOffer | null> { const p = this.m.get(id); return p ? { ...p } : null; }
  async findByOrderId(orderId: string): Promise<PartialRefundOffer[]> { return Array.from(this.m.values()).filter((p) => p.orderId === orderId).map((p) => ({ ...p })); }
  async update(id: string, patch: Partial<PartialRefundOffer>): Promise<PartialRefundOffer> {
    const p = this.m.get(id); if (!p) throw new ProposalNotFoundError(id);
    const u = { ...p, ...patch, updatedAt: new Date().toISOString() }; this.m.set(id, u); return { ...u };
  }
}

// ---------------------------------------------------------------------------
// Postgres implementation
// ---------------------------------------------------------------------------

interface ProposalRow extends QueryResultRow {
  proposal_id: string; order_id: string; escrow_id: string; total_order_stroops: string;
  proposer_role: "buyer" | "merchant"; buyer_refund_stroops: string; merchant_payout_stroops: string;
  status: "proposed" | "countered" | "accepted" | "expired";
  buyer_signature: string | null; merchant_signature: string | null;
  expires_at: Date; created_at: Date; updated_at: Date;
}

const toOffer = (r: ProposalRow): PartialRefundOffer => ({
  proposalId: r.proposal_id, orderId: r.order_id, escrowId: r.escrow_id,
  totalOrderStroops: r.total_order_stroops, proposerRole: r.proposer_role,
  buyerRefundStroops: r.buyer_refund_stroops, merchantPayoutStroops: r.merchant_payout_stroops,
  status: r.status, buyerSignature: r.buyer_signature ?? undefined, merchantSignature: r.merchant_signature ?? undefined,
  expiresAt: r.expires_at.toISOString(), createdAt: r.created_at.toISOString(), updatedAt: r.updated_at.toISOString(),
});

let pgPool: Pool | null = null;
const getPgPool = () => pgPool ??= new Pool({ connectionString: process.env.DATABASE_URL ?? "postgresql://delego:delego@localhost:5432/delego" });
export function _setProposalPoolForTesting(p: Pool): void { pgPool = p; }
export function _resetProposalPool(): void { pgPool = null; }

export class PostgresPartialRefundProposalStore implements PartialRefundProposalStore {
  async create(input: CreatePartialRefundOfferInput): Promise<PartialRefundOffer> {
    assertBalance(input.buyerRefundStroops, input.merchantPayoutStroops, input.totalOrderStroops);
    const expiresAt = input.expiresAt ?? new Date(Date.now() + 48 * 3600_000).toISOString();
    const { rows } = await getPgPool().query<ProposalRow>(
      `INSERT INTO dispute_partial_refund_proposals (order_id,escrow_id,total_order_stroops,proposer_role,buyer_refund_stroops,merchant_payout_stroops,status,buyer_signature,merchant_signature,expires_at)
       VALUES ($1,$2,$3,$4,$5,$6,'proposed',$7,$8,$9) RETURNING *`,
      [input.orderId, input.escrowId, input.totalOrderStroops, input.proposerRole, input.buyerRefundStroops, input.merchantPayoutStroops,
       input.proposerRole === "buyer" ? input.signature : null, input.proposerRole === "merchant" ? input.signature : null, expiresAt]
    );
    return toOffer(rows[0]);
  }
  async findById(id: string): Promise<PartialRefundOffer | null> {
    const { rows } = await getPgPool().query<ProposalRow>(`SELECT * FROM dispute_partial_refund_proposals WHERE proposal_id = $1`, [id]);
    return rows[0] ? toOffer(rows[0]) : null;
  }
  async findByOrderId(orderId: string): Promise<PartialRefundOffer[]> {
    const { rows } = await getPgPool().query<ProposalRow>(`SELECT * FROM dispute_partial_refund_proposals WHERE order_id = $1 ORDER BY created_at DESC`, [orderId]);
    return rows.map(toOffer);
  }
  async update(id: string, patch: Partial<PartialRefundOffer>): Promise<PartialRefundOffer> {
    const fields: string[] = []; const values: unknown[] = [id];
    const add = (col: string, v: unknown) => { values.push(v); fields.push(`${col} = $${values.length}`); };
    if (patch.status !== undefined) add("status", patch.status);
    if (patch.buyerRefundStroops !== undefined) add("buyer_refund_stroops", patch.buyerRefundStroops);
    if (patch.merchantPayoutStroops !== undefined) add("merchant_payout_stroops", patch.merchantPayoutStroops);
    if (patch.buyerSignature !== undefined) add("buyer_signature", patch.buyerSignature);
    if (patch.merchantSignature !== undefined) add("merchant_signature", patch.merchantSignature);
    fields.push("updated_at = NOW()");
    const { rows } = await getPgPool().query<ProposalRow>(
      `UPDATE dispute_partial_refund_proposals SET ${fields.join(", ")} WHERE proposal_id = $1 RETURNING *`, values
    );
    if (!rows[0]) throw new ProposalNotFoundError(id);
    return toOffer(rows[0]);
  }
}

// ---------------------------------------------------------------------------
// Singleton
// ---------------------------------------------------------------------------

let store: PartialRefundProposalStore = new InMemoryPartialRefundProposalStore();
export const setProposalStore = (s: PartialRefundProposalStore): void => { store = s; };
export const resetProposalStore = (): void => { store = new InMemoryPartialRefundProposalStore(); };
export function enablePostgresProposalStore(): void { store = new PostgresPartialRefundProposalStore(); }
export const getProposalStore = (): PartialRefundProposalStore => store;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function assertBalance(b: string, m: string, t: string): void {
  if (BigInt(b) + BigInt(m) !== BigInt(t)) throw new ArithmeticImbalanceError(b, m, t);
}

function assertOpen(p: PartialRefundOffer): void {
  if (p.status !== "proposed" && p.status !== "countered") throw new ProposalNotOpenError(p.proposalId, p.status);
  if (new Date(p.expiresAt).getTime() <= Date.now()) throw new ProposalNotOpenError(p.proposalId, "expired");
}

async function emit(type: string, orderId: string, payload: Record<string, unknown>): Promise<void> {
  publishPaymentEvent({ type, orderId, payload, occurredAt: new Date().toISOString() })
    .catch((err) => log.warn(`Failed to publish ${type}`, { error: err instanceof Error ? err.message : String(err) }));
}

// ---------------------------------------------------------------------------
// Service functions
// ---------------------------------------------------------------------------

export async function createPartialRefundProposal(input: CreatePartialRefundOfferInput): Promise<PartialRefundOffer> {
  const p = await store.create(input);
  await emit("dispute.partial_refund.proposed", p.orderId, { proposalId: p.proposalId, proposerRole: p.proposerRole });
  return p;
}

export async function counterPartialRefundProposal(proposalId: string, role: "buyer" | "merchant", input: CounterOfferInput): Promise<PartialRefundOffer> {
  const p = await store.findById(proposalId);
  if (!p) throw new ProposalNotFoundError(proposalId);
  assertOpen(p);
  assertBalance(input.buyerRefundStroops, input.merchantPayoutStroops, p.totalOrderStroops);
  const patch: Partial<PartialRefundOffer> = {
    status: "countered", buyerRefundStroops: input.buyerRefundStroops, merchantPayoutStroops: input.merchantPayoutStroops,
    buyerSignature: role === "buyer" ? input.signature : undefined,
    merchantSignature: role === "merchant" ? input.signature : undefined,
  };
  const updated = await store.update(proposalId, patch);
  await emit("dispute.partial_refund.countered", updated.orderId, { proposalId, role, buyerRefundStroops: input.buyerRefundStroops, merchantPayoutStroops: input.merchantPayoutStroops });
  return updated;
}

/** Record a party's signature; dispatch split disbursement when both parties have signed. */
export async function signPartialRefundProposal(proposalId: string, input: SignOfferInput): Promise<PartialRefundOffer> {
  const p = await store.findById(proposalId);
  if (!p) throw new ProposalNotFoundError(proposalId);
  assertOpen(p);
  const patch: Partial<PartialRefundOffer> = input.role === "buyer" ? { buyerSignature: input.signature } : { merchantSignature: input.signature };
  let updated = await store.update(proposalId, patch);
  if (updated.buyerSignature && updated.merchantSignature) {
    updated = await store.update(proposalId, { status: "accepted" });
    await dispatchSplitDisbursement(updated);
  }
  return updated;
}

export async function expirePartialRefundProposals(orderId: string): Promise<number> {
  const proposals = await store.findByOrderId(orderId);
  let count = 0;
  for (const p of proposals) {
    if ((p.status === "proposed" || p.status === "countered") && new Date(p.expiresAt).getTime() <= Date.now()) {
      await store.update(p.proposalId, { status: "expired" });
      count++;
    }
  }
  return count;
}

async function dispatchSplitDisbursement(p: PartialRefundOffer): Promise<void> {
  const contractId = getEscrowContractId();
  try {
    if (BigInt(p.buyerRefundStroops) > 0n) {
      await escrowCoordinator.partialRefundEscrow({ escrowId: p.escrowId, escrowContractId: contractId, callerAddress: p.buyerSignature ?? "", amountStroops: p.buyerRefundStroops, reason: `Negotiated partial refund — ${p.proposalId}` });
    }
    if (BigInt(p.merchantPayoutStroops) > 0n) {
      await escrowCoordinator.partialReleaseEscrow({ escrowId: p.escrowId, escrowContractId: contractId, callerAddress: p.merchantSignature ?? "", amountStroops: p.merchantPayoutStroops, memo: `Negotiated partial release — ${p.proposalId}` });
    }
    await emit("dispute.partial_refund.settled", p.orderId, { proposalId: p.proposalId, buyerRefundStroops: p.buyerRefundStroops, merchantPayoutStroops: p.merchantPayoutStroops });
    log.info("Split disbursement dispatched", { proposalId: p.proposalId });
  } catch (err) {
    log.error("Split disbursement failed", { proposalId: p.proposalId, error: err instanceof Error ? err.message : String(err) });
  }
}
