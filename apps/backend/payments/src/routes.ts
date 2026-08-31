import type { IncomingMessage, ServerResponse } from "node:http";
import { route, json, createHealthRoutes, readBodyWithLimit, PayloadTooLargeError, type Route } from "@delegolabs/utils";
import { escrowService } from "../escrow/index.js";
import { getPaymentsHealth } from "../escrow/health.js";
import { createPaymentsHealthRegistry } from "./health.js";
import { handleDeliveryConfirmationWebhook } from "../escrow/autoSettlement.js";
import { getWebhookSecret, verifyWebhookSignature, WEBHOOK_SIGNATURE_HEADER } from "./autoRelease/hmac.js";
import { handleDeliveryConfirmation } from "./autoRelease/service.js";
import { EscrowDisputedError, EscrowNotReleasableError } from "./autoRelease/types.js";
import { ContractInvocationError } from "../escrow/errors.js";
import { settleOrder, refundOrder } from "../settlement/index.js";
import { getEscrowFundingLockManager } from "./escrowCoordinator/escrowFundingLock.js";
import {
  acquireLock,
  releaseLock,
  validateDeliveryConfirmation,
  validateDepositRequest,
  validateEscrowContractConfig,
  validateIdempotencyKey,
  validateInitializeRequest,
  validateRefundReasonCode,
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

const paymentsHealthRegistry = createPaymentsHealthRegistry();

// Body is capped at 1MB (see readBodyWithLimit) — an oversized body rejects
// with PayloadTooLargeError, which callers handle by responding 413.
async function readJsonBody(req: IncomingMessage): Promise<Record<string, unknown>> {
  const body = await readBodyWithLimit(req);
  try {
    return body ? (JSON.parse(body) as Record<string, unknown>) : {};
  } catch {
    throw new Error("Invalid JSON body");
  }
}

async function readRawBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    let body = "";
    req.on("data", (chunk) => {
      body += chunk;
    });
    req.on("end", () => resolve(body));
    req.on("error", (err) => reject(err));
  });
}

function validationStatusCode(code: string): number {
  return code === "CONFIG_ERROR" ? 503 : 400;
}

function sendValidationError(res: ServerResponse, error: ValidationError): void {
  json(res, validationStatusCode(error.code), { data: null, error });
}

function sendPayloadTooLargeError(res: ServerResponse, err: PayloadTooLargeError): void {
  json(res, 413, {
    data: null,
    error: { code: "PAYLOAD_TOO_LARGE", message: err.message },
  });
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

function sendContractError(res: ServerResponse, err: ContractInvocationError): void {
  const status = err.retryable ? 503 : 422;
  json(res, status, {
    data: null,
    error: {
      code: err.code,
      message: err.message,
      txHash: err.txHash ?? null,
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
    ...createHealthRoutes({
      registry: paymentsHealthRegistry,
      serviceName: "payments",
      version: "0.0.1",
    }),

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
        if (err instanceof PayloadTooLargeError) {
          sendPayloadTooLargeError(res, err);
          return;
        }
        if (err instanceof Error && err.message === "Invalid JSON body") {
          sendValidationError(res, {
            code: "VALIDATION_ERROR",
            message: "Invalid JSON body",
          });
          return;
        }
        if (err instanceof ContractInvocationError) {
          sendContractError(res, err);
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
        if (err instanceof PayloadTooLargeError) {
          sendPayloadTooLargeError(res, err);
          return;
        }
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
        if (err instanceof ContractInvocationError) {
          sendContractError(res, err);
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
        if (err instanceof PayloadTooLargeError) {
          sendPayloadTooLargeError(res, err);
          return;
        }
        if (err instanceof Error && err.message === "Invalid JSON body") {
          sendValidationError(res, {
            code: "VALIDATION_ERROR",
            message: "Invalid JSON body",
          });
          return;
        }
        if (err instanceof ContractInvocationError) {
          sendContractError(res, err);
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
        if (err instanceof PayloadTooLargeError) {
          sendPayloadTooLargeError(res, err);
          return;
        }
        if (err instanceof Error && err.message === "Invalid JSON body") {
          sendValidationError(res, {
            code: "VALIDATION_ERROR",
            message: "Invalid JSON body",
          });
          return;
        }
        if (err instanceof ContractInvocationError) {
          sendContractError(res, err);
          return;
        }
        sendOperationError(res, "ESCROW_REFUND_FAILED", err);
      }
    }),

    // Issue #35 — order-level escrow compensation, called by the orchestrator's
    // saga compensation steps (which only know orderId, not escrowId). Both
    // settleOrder/refundOrder are idempotent per orderId via payment_records.status,
    // so a retried compensation call safely returns the previously recorded outcome
    // instead of re-invoking the contract.
    route("POST", "/api/v1/orders/:orderId/release", async (_req, res, params) => {
      try {
        const outcome = await settleOrder(params.orderId);
        const status = outcome.status === "failed" ? 502 : 200;
        json(res, status, {
          data: outcome,
          error: outcome.status === "failed" ? { code: "ORDER_RELEASE_FAILED", message: outcome.reason ?? "Release failed" } : null,
        });
      } catch (err) {
        sendOperationError(res, "ORDER_RELEASE_FAILED", err);
      }
    }),

    route("POST", "/api/v1/orders/:orderId/refund", async (req, res, params) => {
      try {
        const body = await readJsonBody(req);
        const reasonValidation = validateRefundReasonCode(body);
        if (!reasonValidation.ok) {
          sendValidationError(res, reasonValidation.error);
          return;
        }

        const outcome = await refundOrder(params.orderId, reasonValidation.value);
        const status = outcome.status === "failed" ? 502 : 200;
        json(res, status, {
          data: outcome,
          error: outcome.status === "failed" ? { code: "ORDER_REFUND_FAILED", message: outcome.reason ?? "Refund failed" } : null,
        });
      } catch (err) {
        if (err instanceof Error && err.message === "Invalid JSON body") {
          sendValidationError(res, {
            code: "VALIDATION_ERROR",
            message: "Invalid JSON body",
          });
          return;
        }
        sendOperationError(res, "ORDER_REFUND_FAILED", err);
      }
    }),

    // Issue #363 — delivery-confirmation webhook auto-triggers escrow release.
    //
    // Issue #24/#445 — this endpoint accepted the webhook with no signature
    // verification at all: anyone who could reach it could forge a delivery
    // confirmation and trigger escrow release. Verified the same way as
    // /escrow/:escrowId/delivery-confirmed (issue #45) — HMAC-SHA256 over the
    // raw body, constant-time comparison, via hmac.ts — reusing that route's
    // ESCROW_WEBHOOK_SECRET since both endpoints sit in the same trust
    // domain (a delivery-confirmation webhook driving escrow release).
    route("POST", "/webhooks/delivery-confirmation", async (req, res) => {
      try {
        const rawBody = await readRawBody(req);

        const secret = getWebhookSecret();
        if (!secret) {
          json(res, 503, {
            data: null,
            error: { code: "CONFIG_ERROR", message: "ESCROW_WEBHOOK_SECRET is not configured" },
          });
          return;
        }

        const signatureHeaderRaw =
          req.headers[WEBHOOK_SIGNATURE_HEADER] ?? req.headers["x-webhook-signature"] ?? req.headers["x-hub-signature-256"];
        const signatureHeader = Array.isArray(signatureHeaderRaw) ? signatureHeaderRaw[0] : signatureHeaderRaw;

        if (!verifyWebhookSignature(rawBody, signatureHeader, secret)) {
          json(res, 401, {
            data: null,
            error: { code: "UNAUTHORIZED", message: "Invalid or missing webhook signature" },
          });
          return;
        }

        let body: Record<string, unknown>;
        try {
          body = rawBody ? (JSON.parse(rawBody) as Record<string, unknown>) : {};
        } catch {
          sendValidationError(res, { code: "VALIDATION_ERROR", message: "Invalid JSON body" });
          return;
        }

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
        if (err instanceof PayloadTooLargeError) {
          sendPayloadTooLargeError(res, err);
          return;
        }
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
    // Issue #45 — HMAC-verified delivery-confirmation webhook driving escrow auto-release.
    route("POST", "/escrow/:escrowId/delivery-confirmed", async (req, res, params) => {
      try {
        const rawBody = await readRawBody(req);

        const secret = getWebhookSecret();
        if (!secret) {
          json(res, 503, {
            data: null,
            error: { code: "CONFIG_ERROR", message: "ESCROW_WEBHOOK_SECRET is not configured" },
          });
          return;
        }

        const signatureHeaderRaw =
          req.headers[WEBHOOK_SIGNATURE_HEADER] ?? req.headers["x-hub-signature-256"];
        const signatureHeader = Array.isArray(signatureHeaderRaw) ? signatureHeaderRaw[0] : signatureHeaderRaw;

        if (!verifyWebhookSignature(rawBody, signatureHeader, secret)) {
          json(res, 401, {
            data: null,
            error: { code: "UNAUTHORIZED", message: "Invalid or missing webhook signature" },
          });
          return;
        }

        let body: Record<string, unknown>;
        try {
          body = rawBody ? (JSON.parse(rawBody) as Record<string, unknown>) : {};
        } catch {
          sendValidationError(res, { code: "VALIDATION_ERROR", message: "Invalid JSON body" });
          return;
        }

        const validated = validateDeliveryConfirmation(body, params.escrowId);
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
        const result = await handleDeliveryConfirmation(validated.value);

        if ("scheduled" in result) {
          json(res, 202, { data: result, error: null });
          return;
        }

        json(res, result.success ? 200 : 502, { data: result, error: null });
      } catch (err) {
        if (err instanceof EscrowDisputedError) {
          json(res, 409, { data: null, error: { code: "ESCROW_DISPUTED", message: err.message } });
          return;
        }
        if (err instanceof EscrowNotReleasableError) {
          json(res, 400, { data: null, error: { code: "ESCROW_NOT_RELEASABLE", message: err.message } });
          return;
        }
        sendOperationError(res, "DELIVERY_CONFIRMED_WEBHOOK_FAILED", err);
      }
    }),

    // Issue #147 — Lock metrics and optimization endpoints
    route("GET", "/escrow/lock/metrics", async (_req, res) => {
      const lockManager = getEscrowFundingLockManager();
      const metrics = lockManager.getMetrics("global");
      const globalContention = lockManager.getGlobalContentionRatio();
      json(res, 200, {
        data: {
          globalContentionRatio: globalContention,
          metrics,
        },
        error: null,
      });
    }),

    route("GET", "/escrow/lock/optimize", async (_req, res) => {
      const lockManager = getEscrowFundingLockManager();
      const optimization = lockManager.optimizeConfig();
      json(res, 200, { data: optimization, error: null });
    }),
  ];
}
