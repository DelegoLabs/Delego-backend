/** Core orchestrator workflow and saga checkpoint types. */

import type { SagaEvent, SagaRecord } from "../src/saga/types.js";

export type PurchaseState =
  | "Discovery"
  | "SpendingCheck"
  | "UserApprovalPending"
  | "EscrowLocking"
  | "MerchantFulfillment"
  | "DeliveryVerification"
  | "Completed"
  | "Refunded";

export type PurchaseEvent =
  | { type: "PRODUCT_FOUND"; productId: string; merchantId: string; totalStroops: bigint }
  | { type: "SPEND_APPROVED" }
  | { type: "SPEND_DENIED"; reason: string }
  | { type: "USER_APPROVED" }
  | { type: "USER_REJECTED" }
  | { type: "ESCROW_LOCKED"; escrowContractId: string }
  | { type: "ESCROW_FAILED"; reason: string }
  | { type: "FULFILLMENT_CONFIRMED" }
  | { type: "DELIVERY_VERIFIED" }
  | { type: "REFUND_INITIATED"; reason: string };

export interface PurchaseContext {
  workflowId: string;
  delegationId: string;
  userId: string;
  productId: string | null;
  merchantId: string | null;
  totalStroops: bigint | null;
  escrowContractId: string | null;
  rejectionReason: string | null;
  createdAt: Date;
  updatedAt: Date;
}

export interface StateTransitionRecord {
  workflowId: string;
  fromState: PurchaseState | null;
  toState: PurchaseState;
  event: string;
  context: PurchaseContext;
  timestamp: Date;
}

export interface WorkflowSnapshot {
  workflowId: string;
  currentState: PurchaseState;
  context: PurchaseContext;
  history: StateTransitionRecord[];
  version: number;
  /**
   * #347 — Optional absolute deadline for this workflow.
   * When set, the timeout checker (workflows/timeout.ts) will treat the
   * workflow as stuck once `Date.now() > timeoutAt.getTime()` — even if
   * `updatedAt` is recent (e.g. a lease keep-alive is refreshing it).
   *
   * Set this during workflow creation to a reasonable wall-clock deadline
   * (e.g. `new Date(Date.now() + 30 * 60 * 1000)` for 30 minutes).
   * Leave it `undefined` to fall back to the inactivity-based detection
   * already implemented in `findStuckWorkflows`.
   */
  timeoutAt?: Date;
}

/**
 * Persistence boundary for durable workflow checkpoints and their audit events.
 * Implementations must preserve optimistic version checks when saving a record.
 */
export interface WorkflowStateStore {
  /** Inserts a checkpoint, returning the existing record for an idempotent retry. */
  create(record: SagaRecord): Promise<SagaRecord>;
  /** @deprecated use create; retained for existing timeout-recovery callers. */
  createIfNotExists(record: SagaRecord): Promise<SagaRecord>;
  get(workflowId: string): Promise<SagaRecord | null>;
  /** Persists a checkpoint and increments its version, rejecting stale writes. */
  save(record: SagaRecord): Promise<SagaRecord>;
  /** Returns workflows that can be resumed after a process restart. */
  listIncomplete(): Promise<SagaRecord[]>;
  /** Returns workflows whose deadline has passed. */
  listTimedOut(): Promise<SagaRecord[]>;
  /** Appends an immutable audit event. */
  appendEvent(event: SagaEvent): Promise<void>;
  /** Returns a workflow's audit events in append order. */
  getEvents(workflowId: string): Promise<SagaEvent[]>;
  /** Looks up a workflow by its distributed tracing correlation id. */
  findByCorrelationId(correlationId: string): Promise<SagaRecord | null>;
}

export interface SnapshotValidationResult {
  valid: boolean;
  errors: string[];
}
