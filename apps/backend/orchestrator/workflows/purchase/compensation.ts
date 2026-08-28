/**
 * #341 — Purchase workflow compensation.
 * #35  — Escrow compensation flow: release/refund/cancel are now wired to the
 *        payments service and a merchant cancellation client instead of TODO stubs.
 *
 * When a step in the purchase saga fails (e.g. escrow is partially released
 * but settlement subsequently fails), this module runs the compensating
 * actions in strict reverse order — "undoing" each completed step.
 *
 * Every compensation action is logged to the workflow transition audit trail
 * so operators have a full, durable record of what was rolled back. The final
 * outcome of the whole run is additionally persisted on the workflow record
 * (workflow_compensation_outcomes, #35) so operators don't have to replay the
 * audit trail just to see the end state.
 *
 * Design notes
 * ─────────────
 * • Each CompensationStep carries its own compensate() function so that the
 *   list of steps is the single source of truth for both forward and backward
 *   execution (matching the SagaCoordinator pattern already in the codebase).
 * • The compensator is intentionally synchronous in its orchestration —
 *   individual compensate() callbacks are async but they run sequentially to
 *   avoid interleaved partial rollbacks.
 * • All errors are re-thrown after the audit record is written so callers can
 *   decide on retry strategy.
 * • Idempotency: fundEscrow's and settleEscrow's compensations call
 *   payments.release()/refund(), both of which are idempotent per orderId
 *   (apps/backend/payments/settlement/index.ts) — a retried compensation step
 *   safely re-observes the same outcome instead of double-refunding.
 * • Retries are bounded, not unlimited: each step retries within a fixed
 *   budget (retryWithLeaseBudget's `deadlineMs`) kept comfortably under the
 *   saga step's claim lease (see src/saga/coordinator.ts's claimStep), so a
 *   compensation step never keeps retrying past the point where another
 *   runner could legitimately reclaim the same step and duplicate the work.
 */

import { createLogger } from "@delegolabs/utils";
import {
  insertWorkflowTransitionAudit,
} from "../../state/workflow-transition-audit.js";
import { upsertCompensationOutcome } from "../../state/compensation-outcome.js";
import type { PurchaseContext } from "../../state/types.js";
import {
  createHttpPaymentsCompensationClient,
  type PaymentsCompensationClient,
} from "./paymentsCompensationClient.js";
import {
  defaultMerchantCancellationClient,
  type MerchantCancellationClient,
} from "./merchantCancellationClient.js";
import { moveToDeadLetter } from "../timeout.js";
import type { SagaRecord } from "../../src/saga/types.js";

const log = createLogger("orchestrator:purchase:compensation", process.env.LOG_LEVEL ?? "info");

// ─── Types ────────────────────────────────────────────────────────────────────

export interface CompensationStep {
  /** Human-readable name used in audit logs. */
  name: string;
  /**
   * Runs the rollback action for this step.
   * Receives the current (possibly partial) context and the originating error.
   * Returns an updated context that reflects the compensation outcome.
   */
  compensate(context: PurchaseContext, cause: Error): Promise<PurchaseContext>;
}

export type CompensationStatus = "success" | "partial_failure";

export interface CompensationResult {
  status: CompensationStatus;
  /** Steps that were successfully compensated (in execution order — last first). */
  compensatedSteps: string[];
  /** Steps that could not be compensated (require manual intervention). */
  failedSteps: Array<{ step: string; error: string }>;
  /** Final context after all compensations have been attempted. */
  finalContext: PurchaseContext;
  /**
   * True when at least one step's failure was specifically an escrow refund/release
   * that could not be driven to a terminal state after bounded retries — the
   * "stuck refund" failure mode called out in #35. Such runs are also pushed to
   * the dead letter queue for operator follow-up (see OPERATIONAL_RUNBOOK_DLQ.md).
   */
  escrowStuck: boolean;
}

/** Reason codes accepted by the payments service's order-level refund endpoint. */
export type RefundReasonCode = "timeout" | "buyer_cancelled" | "merchant_cancelled" | "dispute_buyer" | "system_error";

export interface CompensationDependencies {
  paymentsClient: PaymentsCompensationClient;
  merchantClient: MerchantCancellationClient;
}

// ─── Bounded retry helper ──────────────────────────────────────────────────────

/**
 * Thrown by a retried operation to signal "this will never succeed, don't
 * bother retrying" — e.g. a caller-configuration error like a missing client
 * rather than a transient failure. retryWithLeaseBudget rethrows it immediately
 * instead of consuming its lease budget on retries that cannot possibly help.
 */
export class NonRetryableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "NonRetryableError";
  }
}

/**
 * Retries `fn` with exponential backoff, bounded by wall-clock time rather than
 * attempt count: it stops as soon as the next attempt would start after
 * `deadlineMs` has elapsed since the first call. This is what "retries bounded
 * by the saga lease" (#35) means in practice — a compensation step must not
 * keep retrying past the point where its SagaCoordinator claim lease could
 * expire and let another runner legitimately reclaim (and re-run) the same step.
 *
 * `deadlineMs` should be comfortably under the coordinator's claimLeaseMs
 * (default 30s, src/saga/coordinator.ts) to leave margin for the claim-write
 * itself and any queuing delay.
 */
export async function retryWithLeaseBudget<T>(
  fn: () => Promise<T>,
  options: {
    deadlineMs: number;
    baseDelayMs?: number;
    maxDelayMs?: number;
    sleep?: (ms: number) => Promise<void>;
    /** Injectable clock — tests advance this alongside a fake `sleep` to simulate elapsed time deterministically. */
    now?: () => number;
  }
): Promise<T> {
  const baseDelayMs = options.baseDelayMs ?? 200;
  const maxDelayMs = options.maxDelayMs ?? 5000;
  const sleep = options.sleep ?? ((ms: number) => new Promise((resolve) => setTimeout(resolve, ms)));
  const now = options.now ?? Date.now;
  const start = now();

  let attempt = 0;
  let lastError: Error = new Error("retryWithLeaseBudget: fn never ran");

  while (true) {
    attempt += 1;
    try {
      return await fn();
    } catch (err) {
      lastError = err instanceof Error ? err : new Error(String(err));

      if (lastError instanceof NonRetryableError) {
        throw lastError;
      }

      const elapsed = now() - start;
      const delay = Math.min(baseDelayMs * 2 ** (attempt - 1), maxDelayMs);

      if (elapsed + delay >= options.deadlineMs) {
        throw lastError;
      }

      await sleep(delay);
    }
  }
}

// ─── Default compensation steps for the purchase saga ────────────────────────

/**
 * How much of the saga step's claim lease compensation retries are allowed to
 * consume. Leaves margin below the coordinator's default 30s lease
 * (src/saga/coordinator.ts DEFAULT_CLAIM_LEASE_MS) for the claim write itself,
 * network latency, and the audit-record write that follows.
 */
const DEFAULT_RETRY_BUDGET_MS = 20_000;

function refundReasonForCause(_cause: Error): RefundReasonCode {
  // The saga doesn't currently classify *why* a step failed beyond the Error
  // message, so compensation-triggered refunds are recorded as system-initiated
  // rather than guessing at buyer/merchant intent from free-text error messages.
  return "system_error";
}

/**
 * Builds the default purchase-saga compensation steps against real payments/
 * merchant clients. Call this (instead of using a hardcoded array) so callers
 * can inject clients — e.g. createHttpPaymentsCompensationClient() in
 * production wiring, or mocks in tests.
 */
export function createDefaultPurchaseCompensationSteps(
  deps: CompensationDependencies,
  retryBudgetMs = DEFAULT_RETRY_BUDGET_MS
): CompensationStep[] {
  return [
    {
      name: "fundEscrow",
      async compensate(ctx, _cause) {
        log.info("Compensation: releasing escrow funds", {
          workflowId: ctx.workflowId,
          escrowContractId: ctx.escrowContractId,
        });

        if (!ctx.escrowContractId) {
          log.info("Compensation: no escrow contract on context, nothing to release", {
            workflowId: ctx.workflowId,
          });
          return ctx;
        }

        const outcome = await retryWithLeaseBudget(
          () => deps.paymentsClient.release(ctx.workflowId),
          { deadlineMs: retryBudgetMs }
        );

        if (outcome.status === "failed") {
          throw new Error(`Escrow release failed for order ${ctx.workflowId}: ${outcome.reason ?? "unknown reason"}`);
        }

        log.info("Compensation: escrow release outcome", {
          workflowId: ctx.workflowId,
          status: outcome.status,
          alreadySettled: outcome.alreadySettled,
        });

        return { ...ctx, escrowContractId: null };
      },
    },
    {
      name: "confirmPurchase",
      async compensate(ctx, cause) {
        log.info("Compensation: cancelling merchant order", {
          workflowId: ctx.workflowId,
        });

        try {
          const outcome = await retryWithLeaseBudget(
            async () => {
              try {
                return await deps.merchantClient.cancel(ctx.workflowId, refundReasonForCause(cause));
              } catch (err) {
                // A merchant service doesn't exist in every deployment of this repo yet
                // (see merchantCancellationClient.ts's stub default) — that's a caller
                // configuration problem, not a transient failure, so it must not consume
                // this step's retry budget. Re-thrown as NonRetryableError so
                // retryWithLeaseBudget fails fast on the first attempt instead of
                // backing off for up to retryBudgetMs.
                if (err instanceof Error && err.message === "MerchantCancellationClient not configured") {
                  throw new NonRetryableError(err.message);
                }
                throw err;
              }
            },
            { deadlineMs: retryBudgetMs }
          );

          if (outcome.status === "failed") {
            throw new Error(`Merchant cancellation failed for order ${ctx.workflowId}: ${outcome.reason ?? "unknown reason"}`);
          }

          log.info("Compensation: merchant cancellation outcome", {
            workflowId: ctx.workflowId,
            status: outcome.status,
          });
        } catch (err) {
          // Treat "not configured" as a soft-skip rather than blocking escrow refund
          // on it, since escrow funds are the higher-priority thing to recover. Any
          // other failure (a real merchant service that rejected the cancellation)
          // still fails the step so it shows up in failedSteps for operator review.
          if (err instanceof NonRetryableError) {
            log.warn("Compensation: merchant cancellation client not configured, skipping", {
              workflowId: ctx.workflowId,
            });
            return ctx;
          }
          throw err;
        }

        return ctx;
      },
    },
    {
      name: "settleEscrow",
      async compensate(ctx, cause) {
        log.info("Compensation: reversing settlement", {
          workflowId: ctx.workflowId,
        });

        const outcome = await retryWithLeaseBudget(
          () => deps.paymentsClient.refund(ctx.workflowId, refundReasonForCause(cause)),
          { deadlineMs: retryBudgetMs }
        );

        if (outcome.status === "failed") {
          throw new Error(`Escrow refund failed for order ${ctx.workflowId}: ${outcome.reason ?? "unknown reason"}`);
        }

        log.info("Compensation: escrow refund outcome", {
          workflowId: ctx.workflowId,
          status: outcome.status,
          alreadySettled: outcome.alreadySettled,
        });

        return ctx;
      },
    },
  ];
}

/**
 * Default steps used when runCompensation() isn't given an explicit `allSteps`
 * argument. The payments client is the real HTTP implementation — the payments
 * service exists and its /api/v1/orders/:orderId/release|refund endpoints are
 * live (see apps/backend/payments/src/routes.ts) — so escrow release/refund
 * works out of the box. The merchant client stays on the stub default because
 * no merchant microservice exists in this monorepo yet (see
 * merchantCancellationClient.ts); confirmPurchase's compensate() treats that
 * "not configured" error as a soft-skip rather than failing the whole run, so
 * escrow funds are still recovered even before a merchant service exists.
 * Once one does, swap this via createDefaultPurchaseCompensationSteps({
 * paymentsClient, merchantClient: createHttpMerchantCancellationClient() }).
 */
export const DEFAULT_PURCHASE_COMPENSATION_STEPS: CompensationStep[] = createDefaultPurchaseCompensationSteps({
  paymentsClient: createHttpPaymentsCompensationClient(),
  merchantClient: defaultMerchantCancellationClient,
});

/** Step names whose failure indicates escrow funds specifically are stuck (not just merchant-side cleanup). */
const ESCROW_CRITICAL_STEPS = new Set(["fundEscrow", "settleEscrow"]);

// ─── Core compensator ─────────────────────────────────────────────────────────

/**
 * Runs compensations for the completed steps of a failed purchase workflow.
 *
 * Steps are compensated in reverse order relative to `completedStepNames` so
 * that the most recently completed action is undone first — preserving
 * transactional integrity.
 *
 * All compensations are attempted even when one fails; the result indicates
 * which steps succeeded and which require manual review. When an
 * escrow-critical step (fundEscrow/settleEscrow — i.e. an actual refund or
 * release call, not just merchant cleanup) fails, the run is additionally
 * pushed to the dead letter queue so it surfaces to operators the same way a
 * stuck workflow does elsewhere in this service — see
 * OPERATIONAL_RUNBOOK_ESCROW_COMPENSATION.md for the runbook.
 *
 * @param workflowId       The saga / workflow identifier (for audit records) — also
 *                         used as the orderId when calling the payments/merchant
 *                         services, matching how the rest of this module already
 *                         treats workflowId as the order-level key.
 * @param completedStepNames  Names of steps that completed successfully (forward order).
 * @param context          The workflow context at the time of failure.
 * @param cause            The error that triggered compensation.
 * @param allSteps         Full set of available compensation steps (default: purchase saga steps).
 */
export async function runCompensation(
  workflowId: string,
  completedStepNames: string[],
  context: PurchaseContext,
  cause: Error,
  allSteps: CompensationStep[] = DEFAULT_PURCHASE_COMPENSATION_STEPS,
): Promise<CompensationResult> {
  // Build a lookup so we can find compensators by name
  const stepMap = new Map(allSteps.map((s) => [s.name, s]));

  // Run in reverse order — last completed step is undone first
  const toCompensate = [...completedStepNames].reverse();

  const compensatedSteps: string[] = [];
  const failedSteps: Array<{ step: string; error: string }> = [];
  let currentContext = context;
  let escrowStuck = false;

  log.info("Starting workflow compensation", {
    workflowId,
    steps: toCompensate,
    cause: cause.message,
  });

  for (const stepName of toCompensate) {
    const step = stepMap.get(stepName);
    if (!step) {
      log.warn("No compensator registered for step — skipping", { workflowId, step: stepName });
      failedSteps.push({ step: stepName, error: "No compensator registered" });
      continue;
    }

    try {
      currentContext = await step.compensate(currentContext, cause);

      // Record each successful compensation in the audit trail
      await insertWorkflowTransitionAudit({
        orderId: workflowId,
        fromState: stepName,
        toState: `${stepName}_compensated`,
        eventType: "COMPENSATION",
      });

      compensatedSteps.push(stepName);
      log.info("Compensation step succeeded", { workflowId, step: stepName });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      log.error("Compensation step failed", { workflowId, step: stepName, error: message });

      // Still write an audit record so operators can see the failure
      try {
        await insertWorkflowTransitionAudit({
          orderId: workflowId,
          fromState: stepName,
          toState: `${stepName}_compensation_failed`,
          eventType: "COMPENSATION_FAILED",
        });
      } catch (auditErr) {
        log.error("Failed to write compensation audit record", {
          workflowId,
          step: stepName,
          error: auditErr instanceof Error ? auditErr.message : String(auditErr),
        });
      }

      failedSteps.push({ step: stepName, error: message });
      if (ESCROW_CRITICAL_STEPS.has(stepName)) {
        escrowStuck = true;
      }
    }
  }

  const status: CompensationStatus = failedSteps.length === 0 ? "success" : "partial_failure";

  log.info("Workflow compensation finished", {
    workflowId,
    status,
    compensatedSteps,
    failedStepCount: failedSteps.length,
    escrowStuck,
  });

  // #35 — Persist the outcome on the workflow record (distinct from the
  // per-step audit trail above), so the workflow's compensation state is
  // visible without replaying every audit row. Best-effort: a failure here
  // must not mask the compensation result itself.
  try {
    await upsertCompensationOutcome({
      workflowId,
      status: escrowStuck ? "escrow_stuck" : status,
      compensatedSteps,
      failedSteps,
      cause: cause.message,
    });
  } catch (err) {
    log.error("Failed to persist compensation outcome", {
      workflowId,
      error: err instanceof Error ? err.message : String(err),
    });
  }

  if (escrowStuck) {
    try {
      const stuckStep = failedSteps.find((f) => ESCROW_CRITICAL_STEPS.has(f.step));
      const dlqEntry: SagaRecord = {
        sagaId: workflowId,
        orderId: workflowId,
        status: "failed",
        completedSteps: compensatedSteps,
        context: currentContext as unknown as Record<string, unknown>,
        currentStep: stuckStep?.step ?? null,
        error: stuckStep?.error ?? cause.message,
        version: 0,
        claimExpiresAt: null,
        createdAt: new Date(),
        updatedAt: new Date(),
      };
      await moveToDeadLetter(
        dlqEntry,
        `Escrow compensation stuck: ${stuckStep?.step ?? "unknown step"} — ${stuckStep?.error ?? cause.message}`
      );
      log.error("Compensation escrow-stuck — pushed to DLQ for operator review", {
        workflowId,
        step: stuckStep?.step,
      });
    } catch (err) {
      log.error("Failed to push escrow-stuck compensation to DLQ", {
        workflowId,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  return {
    status,
    compensatedSteps,
    failedSteps,
    finalContext: currentContext,
    escrowStuck,
  };
}
