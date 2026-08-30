/** Partial Refunds & Dispute Mediation (Issue #46) — public API. */

export {
  DEFAULT_SLA_DAYS,
  assignMediator,
  autoAssignMediator,
  executeDecision,
  openDispute,
  submitEvidence,
  submitMediationDecision,
  type OpenDisputeParams,
} from "./mediation.js";

export { InvalidPartialRefundAmountError, executePartialRefund, type PartialRefundOutcome } from "./partialRefund.js";

export { findAndEscalateBreachedDisputes, startSlaEscalationScheduler, type SlaEscalationResult } from "./slaEscalation.js";

export {
  enablePostgresDisputeStore,
  getDisputeStore,
  resetDisputeStore,
  setDisputeStore,
  InMemoryDisputeStore,
  type CreateDisputeInput,
  type DisputeStore,
  type DisputeUpdate,
} from "./disputeStore.js";

export {
  enablePostgresAuditLogStore,
  listAuditLogForDispute,
  recordAuditEvent,
  resetAuditLogStore,
  setAuditLogStore,
  type AuditLogEntry,
  type AuditLogStore,
} from "./auditLog.js";

export {
  classifyOutcome,
  enablePostgresReputationStore,
  getDisputeReputation,
  recordDisputeInitiated,
  recordDisputeInvolved,
  recordDisputeOutcome,
  resetReputationStore,
  setReputationStore,
  type DisputeReputationRecord,
  type ResolutionOutcome,
} from "./reputationStore.js";

export { assertTransition, canTransition, isTerminal, planAdvance } from "./stateMachine.js";

export type {
  Dispute,
  DisputeEvidenceEntry,
  DisputeEvidenceInput,
  DisputeResolution,
  DisputeStatus,
  MediationDecision,
  PartialRefundRequest,
  ResolutionType,
} from "./types.js";
export {
  DisputeAlreadyResolvedError,
  DisputeNotFoundError,
  InsufficientEscrowBalanceError,
  InvalidResolutionAmountsError,
  InvalidStateTransitionError,
} from "./types.js";
