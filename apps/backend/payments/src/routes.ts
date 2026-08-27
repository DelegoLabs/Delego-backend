import type { IncomingMessage, ServerResponse } from "node:http";
import { route, json, type Route } from "@delegolabs/utils";
import { escrowService } from "../escrow/index.js";
import { getPaymentsHealth } from "../escrow/health.js";
import { handleDeliveryConfirmationWebhook } from "../escrow/autoSettlement.js";
import {
  acquireLock,
  releaseLock,
  validateDepositRequest,
  validateEscrowContractConfig,
  validateIdempotencyKey,
  validateInitializeRequest,
  validateRefundRequest,
  validateReleaseRequest,
  type ValidationError,
} from "./validation.js";
import { InsufficientEscrowBalanceError } from "./escrowCoordinator/index.js";
import { assignMediator, executeDecision, openDispute, submitEvidence, submitMediationDecision } from "./disputes/mediation.js";
import { executePartialRefund, InvalidPartialRefundAmountError } from "./disputes/partialRefund.js";
import { getDisputeStore } from "./disputes/disputeStore.js";
import { listAuditLogForDispute } from "./disputes/auditLog.js";
import {
  DisputeAlreadyResolvedError,
  DisputeNotFoundError,
  InvalidResolutionAmountsError,
  InvalidStateTransitionError,
} from "./disputes/types.js";
import {
  validateAssignMediatorRequest,
  validateMediationDecision,
  validateOpenDisputeRequest,
  validatePartialRefundRequest,
  validateSubmitEvidenceRequest,
} from "./disputes/validation.js";
import {
  cancelSubscription,
  changeSubscriptionPlan,
  createSubscription,
  createSubscriptionPlan,
  getSubscription,
  getSubscriptionPlan,
  pauseSubscription,
  renewSubscription,
  resumeSubscription,
} from "./subscriptions/service.js";
import {
  SubscriptionNotActiveError,
  SubscriptionNotFoundError,
  SubscriptionPlanNotFoundError,
  UnsupportedPaymentMethodError,
} from "./subscriptions/types.js";
import {
  validateCancelSubscriptionRequest,
  validateChangePlanRequest,
  validateCreatePlanRequest,
  validateCreateSubscriptionRequest,
  validateRenewRequest,
} from "./subscriptions/validation.js";

async function readJsonBody(req: IncomingMessage): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    let body = "";
    req.on("data", (chunk) => {
      body += chunk;
    });
    req.on("end", () => {
      try {
        resolve(body ? (JSON.parse(body) as Record<string, unknown>) : {});
      } catch {
        reject(new Error("Invalid JSON body"));
      }
    });
    req.on("error", (err) => {
      reject(err);
    });
  });
}

function validationStatusCode(code: string): number {
  return code === "CONFIG_ERROR" ? 503 : 400;
}

function sendValidationError(res: ServerResponse, error: ValidationError): void {
  json(res, validationStatusCode(error.code), { data: null, error });
}

function sendOperationError(res: ServerResponse, code: string, err: unknown): void {
  json(res, 400, {
    data: null,
    error: {
      code,
      message: err instanceof Error ? err.message : "Unknown error",
    },
  });
}

function isDuplicateKeyError(err: unknown): boolean {
  if (typeof err === "object" && err !== null) {
    const code = (err as { code?: string }).code;
    const message = (err as { message?: string }).message ?? "";
    return code === "23505" || message.includes("duplicate key") || message.includes("unique constraint");
  }
  return false;
}

/**
 * Maps the typed errors thrown by the disputes/partial-refund service layer
 * to HTTP status codes. Returns `true` if `err` was handled (a response was
 * sent), `false` otherwise so the caller can fall back to a generic 400/500.
 */
function sendDisputeError(res: ServerResponse, err: unknown): boolean {
  if (err instanceof InsufficientEscrowBalanceError) {
    json(res, 400, {
      data: null,
      error: {
        code: "INSUFFICIENT_ESCROW_BALANCE",
        message: err.message,
        details: { escrowId: err.escrowId, remainingAmount: err.remainingAmount, requestedAmount: err.requestedAmount },
      },
    });
    return true;
  }
  if (err instanceof InvalidPartialRefundAmountError || err instanceof InvalidResolutionAmountsError) {
    json(res, 400, { data: null, error: { code: "VALIDATION_ERROR", message: err.message } });
    return true;
  }
  if (err instanceof DisputeNotFoundError) {
    json(res, 404, { data: null, error: { code: "DISPUTE_NOT_FOUND", message: err.message } });
    return true;
  }
  if (err instanceof DisputeAlreadyResolvedError) {
    json(res, 409, { data: null, error: { code: "DISPUTE_ALREADY_RESOLVED", message: err.message } });
    return true;
  }
  if (err instanceof InvalidStateTransitionError) {
    json(res, 409, {
      data: null,
      error: { code: "INVALID_STATE_TRANSITION", message: err.message, details: { from: err.from, to: err.to } },
    });
    return true;
  }
  return false;
}

/** Maps typed errors from the subscriptions service layer to HTTP status codes. */
function sendSubscriptionError(res: ServerResponse, err: unknown): boolean {
  if (err instanceof SubscriptionPlanNotFoundError) {
    json(res, 404, { data: null, error: { code: "SUBSCRIPTION_PLAN_NOT_FOUND", message: err.message } });
    return true;
  }
  if (err instanceof SubscriptionNotFoundError) {
    json(res, 404, { data: null, error: { code: "SUBSCRIPTION_NOT_FOUND", message: err.message } });
    return true;
  }
  if (err instanceof SubscriptionNotActiveError) {
    json(res, 409, {
      data: null,
      error: { code: "SUBSCRIPTION_NOT_ACTIVE", message: err.message, details: { status: err.status } },
    });
    return true;
  }
  if (err instanceof UnsupportedPaymentMethodError) {
    json(res, 400, { data: null, error: { code: "UNSUPPORTED_PAYMENT_METHOD", message: err.message } });
    return true;
  }
  return false;
}

async function ensureContractConfig(res: ServerResponse): Promise<boolean> {
  const config = validateEscrowContractConfig();
  if (!config.ok) {
    sendValidationError(res, config.error);
    return false;
  }
  return true;
}

export function registerRoutes(): Route[] {
  return [
    route("GET", "/escrow/health", async (_req, res) => {
      const health = await getPaymentsHealth();
      json(res, 200, { data: health, error: null });
    }),

    route("POST", "/escrow/initialize", async (req, res) => {
      try {
        const body = await readJsonBody(req);
        const validated = validateInitializeRequest(body);
        if (!validated.ok) {
          sendValidationError(res, validated.error);
          return;
        }
        if (!(await ensureContractConfig(res))) return;

        const result = await escrowService.initialize(validated.value);
        json(res, 200, { data: result, error: null });
      } catch (err) {
        if (err instanceof Error && err.message === "Invalid JSON body") {
          sendValidationError(res, {
            code: "VALIDATION_ERROR",
            message: "Invalid JSON body",
          });
          return;
        }
        sendOperationError(res, "ESCROW_INITIALIZE_FAILED", err);
      }
    }),

    route("POST", "/escrow/deposit", async (req, res) => {
      let lockedOrderId: string | undefined;
      try {
        const idempotency = validateIdempotencyKey(req.headers as Record<string, string | string[] | undefined>, "/escrow/deposit");
        if (!idempotency.ok) {
          sendValidationError(res, idempotency.error);
          return;
        }
        const body = await readJsonBody(req);
        const validated = validateDepositRequest(body);
        if (!validated.ok) {
          sendValidationError(res, validated.error);
          return;
        }
        if (!(await ensureContractConfig(res))) return;

        if (validated.value.orderId) {
          lockedOrderId = validated.value.orderId;
          const acquired = await acquireLock(lockedOrderId);
          if (!acquired) {
            json(res, 409, {
              data: null,
              error: {
                code: "DUPLICATE_FUNDING_REQUEST",
                message: `Escrow deposit is already in progress for order ${lockedOrderId}`,
                details: { orderId: lockedOrderId },
              },
            });
            return;
          }
        }

        const result = await escrowService.deposit(validated.value);
        json(res, 200, { data: result, error: null });
      } catch (err) {
        if (err instanceof Error && err.message === "Invalid JSON body") {
          sendValidationError(res, {
            code: "VALIDATION_ERROR",
            message: "Invalid JSON body",
          });
          return;
        }
        if (isDuplicateKeyError(err)) {
          json(res, 409, {
            data: null,
            error: {
              code: "DUPLICATE_FUNDING_REQUEST",
              message: "Escrow deposit record already exists for this order",
              details: { orderId: lockedOrderId },
            },
          });
          return;
        }
        sendOperationError(res, "ESCROW_DEPOSIT_FAILED", err);
      } finally {
        if (lockedOrderId) {
          await releaseLock(lockedOrderId);
        }
      }
    }),


    route("POST", "/escrow/:escrowId/release", async (req, res, params) => {
      try {
        const idempotency = validateIdempotencyKey(req.headers as Record<string, string | string[] | undefined>, "/escrow/:escrowId/release");
        if (!idempotency.ok) {
          sendValidationError(res, idempotency.error);
          return;
        }
        const body = await readJsonBody(req);
        const validated = validateReleaseRequest(body, params.escrowId);
        if (!validated.ok) {
          sendValidationError(res, validated.error);
          return;
        }
        if (!(await ensureContractConfig(res))) return;

        const result = await escrowService.release(validated.value);
        json(res, 200, { data: result, error: null });
      } catch (err) {
        if (err instanceof Error && err.message === "Invalid JSON body") {
          sendValidationError(res, {
            code: "VALIDATION_ERROR",
            message: "Invalid JSON body",
          });
          return;
        }
        sendOperationError(res, "ESCROW_RELEASE_FAILED", err);
      }
    }),

    route("POST", "/escrow/:escrowId/refund", async (req, res, params) => {
      try {
        const idempotency = validateIdempotencyKey(req.headers as Record<string, string | string[] | undefined>, "/escrow/:escrowId/refund");
        if (!idempotency.ok) {
          sendValidationError(res, idempotency.error);
          return;
        }
        const body = await readJsonBody(req);
        const validated = validateRefundRequest(body, params.escrowId);
        if (!validated.ok) {
          sendValidationError(res, validated.error);
          return;
        }
        if (!(await ensureContractConfig(res))) return;

        const result = await escrowService.refund(validated.value);
        json(res, 200, {
          data: {
            ...result,
            refundReasonCode: validated.value.refundReasonCode,
          },
          error: null,
        });

      } catch (err) {
        if (err instanceof Error && err.message === "Invalid JSON body") {
          sendValidationError(res, {
            code: "VALIDATION_ERROR",
            message: "Invalid JSON body",
          });
          return;
        }
        sendOperationError(res, "ESCROW_REFUND_FAILED", err);
      }
    }),

    // Issue #363 — delivery-confirmation webhook auto-triggers escrow release.
    route("POST", "/webhooks/delivery-confirmation", async (req, res) => {
      try {
        const body = await readJsonBody(req);
        const { webhookId, orderId, escrowId, escrowContractId, callerAddress, confirmedAt } = body;

        if (
          typeof webhookId !== "string" ||
          !webhookId ||
          typeof orderId !== "string" ||
          !orderId ||
          typeof escrowId !== "string" ||
          !escrowId ||
          typeof escrowContractId !== "string" ||
          !escrowContractId ||
          typeof callerAddress !== "string" ||
          !callerAddress
        ) {
          sendValidationError(res, {
            code: "VALIDATION_ERROR",
            message:
              "webhookId, orderId, escrowId, escrowContractId, and callerAddress are required",
          });
          return;
        }

        const result = await handleDeliveryConfirmationWebhook({
          webhookId,
          orderId,
          escrowId,
          escrowContractId,
          callerAddress,
          confirmedAt: typeof confirmedAt === "string" ? confirmedAt : new Date().toISOString(),
        });

        json(res, result.status === "failed" ? 502 : 200, { data: result, error: null });
      } catch (err) {
        if (err instanceof Error && err.message === "Invalid JSON body") {
          sendValidationError(res, {
            code: "VALIDATION_ERROR",
            message: "Invalid JSON body",
          });
          return;
        }
        sendOperationError(res, "DELIVERY_WEBHOOK_FAILED", err);
      }
    }),

    // ─── Issue #46 — Partial Refunds & Dispute Mediation ────────────────────

    route("POST", "/escrow/:escrowId/partial-refund", async (req, res, params) => {
      try {
        const body = await readJsonBody(req);
        const validated = validatePartialRefundRequest(body, params.escrowId);
        if (!validated.ok) {
          sendValidationError(res, validated.error);
          return;
        }
        if (!(await ensureContractConfig(res))) return;

        const outcome = await executePartialRefund(validated.value);
        json(res, outcome.success ? 200 : 502, { data: outcome, error: null });
      } catch (err) {
        if (err instanceof Error && err.message === "Invalid JSON body") {
          sendValidationError(res, { code: "VALIDATION_ERROR", message: "Invalid JSON body" });
          return;
        }
        if (sendDisputeError(res, err)) return;
        sendOperationError(res, "PARTIAL_REFUND_FAILED", err);
      }
    }),

    route("POST", "/escrow/:escrowId/disputes", async (req, res, params) => {
      try {
        const body = await readJsonBody(req);
        const validated = validateOpenDisputeRequest(body, params.escrowId);
        if (!validated.ok) {
          sendValidationError(res, validated.error);
          return;
        }

        const dispute = await openDispute(validated.value);
        json(res, 201, { data: dispute, error: null });
      } catch (err) {
        if (err instanceof Error && err.message === "Invalid JSON body") {
          sendValidationError(res, { code: "VALIDATION_ERROR", message: "Invalid JSON body" });
          return;
        }
        if (sendDisputeError(res, err)) return;
        sendOperationError(res, "DISPUTE_OPEN_FAILED", err);
      }
    }),

    route("GET", "/disputes/:disputeId", async (_req, res, params) => {
      const dispute = await getDisputeStore().findById(params.disputeId);
      if (!dispute) {
        json(res, 404, { data: null, error: { code: "DISPUTE_NOT_FOUND", message: `Dispute ${params.disputeId} not found` } });
        return;
      }
      const auditLog = await listAuditLogForDispute(params.disputeId);
      json(res, 200, { data: { ...dispute, auditLog }, error: null });
    }),

    route("POST", "/disputes/:disputeId/evidence", async (req, res, params) => {
      try {
        const body = await readJsonBody(req);
        const validated = validateSubmitEvidenceRequest(body);
        if (!validated.ok) {
          sendValidationError(res, validated.error);
          return;
        }

        const dispute = await submitEvidence(params.disputeId, validated.value);
        json(res, 200, { data: dispute, error: null });
      } catch (err) {
        if (err instanceof Error && err.message === "Invalid JSON body") {
          sendValidationError(res, { code: "VALIDATION_ERROR", message: "Invalid JSON body" });
          return;
        }
        if (sendDisputeError(res, err)) return;
        sendOperationError(res, "DISPUTE_EVIDENCE_FAILED", err);
      }
    }),

    route("POST", "/disputes/:disputeId/mediator", async (req, res, params) => {
      try {
        const body = await readJsonBody(req);
        const validated = validateAssignMediatorRequest(body);
        if (!validated.ok) {
          sendValidationError(res, validated.error);
          return;
        }

        const dispute = await assignMediator(params.disputeId, validated.value.mediator, validated.value.assignedBy);
        json(res, 200, { data: dispute, error: null });
      } catch (err) {
        if (err instanceof Error && err.message === "Invalid JSON body") {
          sendValidationError(res, { code: "VALIDATION_ERROR", message: "Invalid JSON body" });
          return;
        }
        if (sendDisputeError(res, err)) return;
        sendOperationError(res, "DISPUTE_MEDIATOR_ASSIGN_FAILED", err);
      }
    }),

    route("POST", "/disputes/:disputeId/decision", async (req, res, params) => {
      try {
        const body = await readJsonBody(req);
        const validated = validateMediationDecision(body, params.disputeId);
        if (!validated.ok) {
          sendValidationError(res, validated.error);
          return;
        }
        if (!(await ensureContractConfig(res))) return;

        const dispute = await submitMediationDecision(validated.value);
        json(res, 200, { data: dispute, error: null });
      } catch (err) {
        if (err instanceof Error && err.message === "Invalid JSON body") {
          sendValidationError(res, { code: "VALIDATION_ERROR", message: "Invalid JSON body" });
          return;
        }
        if (sendDisputeError(res, err)) return;
        sendOperationError(res, "DISPUTE_DECISION_FAILED", err);
      }
    }),

    // Retries executing an already-recorded decision (e.g. after a transient
    // Soroban failure left the dispute in "decided" rather than "resolved").
    route("POST", "/disputes/:disputeId/decision/retry", async (_req, res, params) => {
      try {
        if (!(await ensureContractConfig(res))) return;
        const dispute = await executeDecision(params.disputeId);
        json(res, 200, { data: dispute, error: null });
      } catch (err) {
        if (sendDisputeError(res, err)) return;
        sendOperationError(res, "DISPUTE_DECISION_RETRY_FAILED", err);
      }
    }),

    // ─── Issue #47 — Recurring Payment Subscriptions with Escrow ────────────

    route("POST", "/subscriptions/plans", async (req, res) => {
      try {
        const body = await readJsonBody(req);
        const validated = validateCreatePlanRequest(body);
        if (!validated.ok) {
          sendValidationError(res, validated.error);
          return;
        }

        const plan = await createSubscriptionPlan(validated.value);
        json(res, 201, { data: plan, error: null });
      } catch (err) {
        if (err instanceof Error && err.message === "Invalid JSON body") {
          sendValidationError(res, { code: "VALIDATION_ERROR", message: "Invalid JSON body" });
          return;
        }
        sendOperationError(res, "SUBSCRIPTION_PLAN_CREATE_FAILED", err);
      }
    }),

    route("GET", "/subscriptions/plans/:planId", async (_req, res, params) => {
      try {
        const plan = await getSubscriptionPlan(params.planId);
        json(res, 200, { data: plan, error: null });
      } catch (err) {
        if (sendSubscriptionError(res, err)) return;
        sendOperationError(res, "SUBSCRIPTION_PLAN_FETCH_FAILED", err);
      }
    }),

    route("POST", "/subscriptions", async (req, res) => {
      try {
        const body = await readJsonBody(req);
        const validated = validateCreateSubscriptionRequest(body);
        if (!validated.ok) {
          sendValidationError(res, validated.error);
          return;
        }

        const subscription = await createSubscription(validated.value);
        json(res, 201, { data: subscription, error: null });
      } catch (err) {
        if (err instanceof Error && err.message === "Invalid JSON body") {
          sendValidationError(res, { code: "VALIDATION_ERROR", message: "Invalid JSON body" });
          return;
        }
        if (sendSubscriptionError(res, err)) return;
        sendOperationError(res, "SUBSCRIPTION_CREATE_FAILED", err);
      }
    }),

    route("GET", "/subscriptions/:subscriptionId", async (_req, res, params) => {
      try {
        const subscription = await getSubscription(params.subscriptionId);
        json(res, 200, { data: subscription, error: null });
      } catch (err) {
        if (sendSubscriptionError(res, err)) return;
        sendOperationError(res, "SUBSCRIPTION_FETCH_FAILED", err);
      }
    }),

    route("POST", "/subscriptions/:subscriptionId/pause", async (_req, res, params) => {
      try {
        const subscription = await pauseSubscription(params.subscriptionId);
        json(res, 200, { data: subscription, error: null });
      } catch (err) {
        if (sendSubscriptionError(res, err)) return;
        sendOperationError(res, "SUBSCRIPTION_PAUSE_FAILED", err);
      }
    }),

    route("POST", "/subscriptions/:subscriptionId/resume", async (_req, res, params) => {
      try {
        const subscription = await resumeSubscription(params.subscriptionId);
        json(res, 200, { data: subscription, error: null });
      } catch (err) {
        if (sendSubscriptionError(res, err)) return;
        sendOperationError(res, "SUBSCRIPTION_RESUME_FAILED", err);
      }
    }),

    route("POST", "/subscriptions/:subscriptionId/cancel", async (req, res, params) => {
      try {
        const body = await readJsonBody(req);
        const validated = validateCancelSubscriptionRequest(body);
        if (!validated.ok) {
          sendValidationError(res, validated.error);
          return;
        }

        const subscription = await cancelSubscription(params.subscriptionId, validated.value);
        json(res, 200, { data: subscription, error: null });
      } catch (err) {
        if (err instanceof Error && err.message === "Invalid JSON body") {
          sendValidationError(res, { code: "VALIDATION_ERROR", message: "Invalid JSON body" });
          return;
        }
        if (sendSubscriptionError(res, err)) return;
        sendOperationError(res, "SUBSCRIPTION_CANCEL_FAILED", err);
      }
    }),

    route("PATCH", "/subscriptions/:subscriptionId/plan", async (req, res, params) => {
      try {
        const body = await readJsonBody(req);
        const validated = validateChangePlanRequest(body);
        if (!validated.ok) {
          sendValidationError(res, validated.error);
          return;
        }

        const subscription = await changeSubscriptionPlan(params.subscriptionId, validated.value.planId);
        json(res, 200, { data: subscription, error: null });
      } catch (err) {
        if (err instanceof Error && err.message === "Invalid JSON body") {
          sendValidationError(res, { code: "VALIDATION_ERROR", message: "Invalid JSON body" });
          return;
        }
        if (sendSubscriptionError(res, err)) return;
        sendOperationError(res, "SUBSCRIPTION_PLAN_CHANGE_FAILED", err);
      }
    }),

    // Manual/forced renewal — also what the billing scheduler calls internally.
    route("POST", "/subscriptions/:subscriptionId/renew", async (req, res, params) => {
      try {
        const body = await readJsonBody(req);
        const validated = validateRenewRequest(body);
        if (!validated.ok) {
          sendValidationError(res, validated.error);
          return;
        }

        const subscription = await renewSubscription(params.subscriptionId, { ...validated.value, force: true });
        json(res, 200, { data: subscription, error: null });
      } catch (err) {
        if (err instanceof Error && err.message === "Invalid JSON body") {
          sendValidationError(res, { code: "VALIDATION_ERROR", message: "Invalid JSON body" });
          return;
        }
        if (sendSubscriptionError(res, err)) return;
        sendOperationError(res, "SUBSCRIPTION_RENEW_FAILED", err);
      }
    }),
  ];
}
