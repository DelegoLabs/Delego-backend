/** Saga coordinator pattern — core types shared by all saga implementations (Issue #48). */

export type SagaWorkflowType = "checkout" | "purchase" | "refund" | "dispute";

export type SagaStatus =
  | "running"
  | "completed"
  | "compensating"
  | "compensated"
  | "failed"
  | "timed_out";

export type CompletedStepStatus = "completed" | "failed" | "compensated";

/**
 * Rich description of a single saga step's outcome. Stored as JSONB so the audit
 * trail and replay context survive a crash.
 */
export interface CompletedStep {
  stepName: string;
  status: CompletedStepStatus;
  output: Record<string, unknown>;
  completedAt: string;
  compensationAction?: string;
}

/**
 * Public, serialized form of a saga execution (string timestamps, per the API contract).
 */
export interface SagaExecution {
  sagaId: string;
  orderId: string;
  workflowType: SagaWorkflowType;
  status: SagaStatus;
  currentStep: string | null;
  completedSteps: CompletedStep[];
  context: Record<string, unknown>;
  version: number;
  correlationId: string;
  createdAt: string;
  updatedAt: string;
  expiresAt?: string;
}

export interface SagaRetryPolicy {
  maxAttempts: number;
  backoffMs: number;
  retryableErrors: string[];
}

export interface SagaStep<TContext = Record<string, unknown>> {
  name: string;
  execute: (context: TContext) => Promise<TContext>;
  compensate: (context: TContext, output: Record<string, unknown>) => Promise<TContext>;
  timeoutMs?: number;
  retryPolicy?: SagaRetryPolicy;
}

/**
 * Durable representation of a saga execution, including the data needed to resume it.
 * Timestamps are `Date` here (Sequelize/JSONB friendly); use {@link serializeSagaExecution}
 * to produce the API-facing {@link SagaExecution}.
 */
export interface SagaRecord<TContext = Record<string, unknown>> {
  sagaId: string;
  orderId: string;
  workflowType: SagaWorkflowType;
  status: SagaStatus;
  currentStep: string | null;
  completedSteps: CompletedStep[];
  context: TContext;
  version: number;
  correlationId: string;
  /** Terminal error message, if the saga failed or is compensating after a failure. */
  error: string | null;
  /** Saga-level deadline for crash recovery. A saga past this is auto-compensated on recovery. */
  expiresAt: Date | null;
  /**
   * Lease expiry for the in-progress `currentStep`. A step can only be reclaimed once this is
   * null or in the past — without it, version-checked saves alone don't stop a second runner
   * from re-claiming (and re-executing) a step that's already being worked on at a newer version.
   */
  claimExpiresAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
}

/** Thrown by SagaStore.save() when `record.version` no longer matches the persisted version. */
export class SagaConcurrencyError extends Error {
  constructor(sagaId: string) {
    super(`Saga ${sagaId} was modified by another runner — aborting to avoid duplicate step execution`);
    this.name = "SagaConcurrencyError";
  }
}

/** A single append-only transition recorded for the saga's event-sourced audit trail. */
export interface SagaEvent {
  sagaId: string;
  correlationId: string;
  eventType: string;
  fromStatus: SagaStatus | null;
  toStatus: SagaStatus | null;
  payload: Record<string, unknown>;
  createdAt: Date;
}

export type SagaRecoveryAction = "resumed" | "compensated" | "marked_failed";

export interface SagaRecoveryDetail {
  sagaId: string;
  action: SagaRecoveryAction;
  reason: string;
}

/** Result returned by recovery — lets the service report what startup recovery did. */
export interface SagaRecoveryResult {
  recovered: number;
  failed: number;
  details: SagaRecoveryDetail[];
}

/**
 * Persistence boundary for saga progress. Implementations must make save() safe to call
 * repeatedly with the same record (upsert keyed on optimistic `version`), since a crash can
 * interrupt execution between a step completing and the saga advancing to the next one.
 */
export interface SagaStore {
  /** Inserts a new saga record. Returns the existing record if sagaId already exists (idempotent start). */
  create(record: SagaRecord): Promise<SagaRecord>;
  /** @deprecated use {@link create}; retained for the #347 timeout processor's existing callers. */
  createIfNotExists(record: SagaRecord): Promise<SagaRecord>;
  get(sagaId: string): Promise<SagaRecord | null>;
  /**
   * Persists record and returns the stored copy with `version` incremented. Throws
   * SagaConcurrencyError if `record.version` doesn't match the persisted version, which is how
   * callers detect that another runner already claimed this step.
   */
  save(record: SagaRecord): Promise<SagaRecord>;
  /** Sagas left in "running" or "compensating" — used to resume after an orchestrator crash. */
  listIncomplete(): Promise<SagaRecord[]>;
  /** Sagas whose lease/expiry deadline has passed and must be auto-recovered or compensated. */
  listTimedOut(): Promise<SagaRecord[]>;
  /** Appends an immutable transition event to the saga audit trail. */
  appendEvent(event: SagaEvent): Promise<void>;
  /** Returns the full ordered audit trail for a saga. */
  getEvents(sagaId: string): Promise<SagaEvent[]>;
  /** Looks up a saga by its correlation id (distributed tracing). */
  findByCorrelationId(correlationId: string): Promise<SagaRecord | null>;
}

export function serializeSagaExecution(record: SagaRecord): SagaExecution {
  return {
    sagaId: record.sagaId,
    orderId: record.orderId,
    workflowType: record.workflowType,
    status: record.status,
    currentStep: record.currentStep,
    completedSteps: record.completedSteps,
    context: record.context as Record<string, unknown>,
    version: record.version,
    correlationId: record.correlationId,
    createdAt: record.createdAt.toISOString(),
    updatedAt: record.updatedAt.toISOString(),
    expiresAt: record.expiresAt ? record.expiresAt.toISOString() : undefined,
  };
}
