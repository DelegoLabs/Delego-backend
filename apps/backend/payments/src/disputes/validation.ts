/**
 * Request validation for the partial-refund and dispute-mediation endpoints
 * (Issue #46). Mirrors the `ValidationResult<T>` convention used by
 * `../validation.ts`.
 */

import type { MediationDecision, PartialRefundRequest, ResolutionType } from "./types.js";

export interface ValidationError {
  code: string;
  message: string;
  details?: Record<string, unknown>;
}

export type ValidationResult<T> = { ok: true; value: T } | { ok: false; error: ValidationError };

function missingField(field: string): ValidationError {
  return { code: "VALIDATION_ERROR", message: `Missing required field: ${field}`, details: { field } };
}

function invalidField(field: string, message: string): ValidationError {
  return { code: "VALIDATION_ERROR", message, details: { field } };
}

function requireString(body: Record<string, unknown>, field: string): ValidationResult<string> {
  const value = body[field];
  if (value === undefined || value === null) return { ok: false, error: missingField(field) };
  if (typeof value !== "string" || value.trim() === "") {
    return { ok: false, error: invalidField(field, `${field} must be a non-empty string`) };
  }
  return { ok: true, value: value.trim() };
}

function requireStroopsAmount(body: Record<string, unknown>, field: string): ValidationResult<string> {
  const str = requireString(body, field);
  if (!str.ok) return str;
  if (!/^[0-9]+$/.test(str.value)) {
    return { ok: false, error: invalidField(field, `${field} must be a non-negative integer string (stroops)`) };
  }
  return str;
}

const RESOLUTION_TYPES: ResolutionType[] = ["full_refund", "partial_refund", "release_to_seller", "split"];

export function validatePartialRefundRequest(
  body: Record<string, unknown>,
  escrowIdParam?: string
): ValidationResult<PartialRefundRequest> {
  if (!escrowIdParam || escrowIdParam.trim() === "") return { ok: false, error: missingField("escrowId") };
  const escrowId = escrowIdParam.trim();

  const amount = requireStroopsAmount(body, "amount");
  if (!amount.ok) return amount;

  const reason = requireString(body, "reason");
  if (!reason.ok) return reason;

  const requestedBy = requireString(body, "requestedBy");
  if (!requestedBy.ok) return requestedBy;

  let evidence: string[] | undefined;
  if (body.evidence !== undefined && body.evidence !== null) {
    if (!Array.isArray(body.evidence) || !body.evidence.every((e) => typeof e === "string")) {
      return { ok: false, error: invalidField("evidence", "evidence must be an array of strings when provided") };
    }
    evidence = body.evidence;
  }

  return {
    ok: true,
    value: { escrowId, amount: amount.value, reason: reason.value, requestedBy: requestedBy.value, evidence },
  };
}

export interface OpenDisputeRequest {
  escrowId: string;
  initiatedBy: string;
  reason: string;
  slaDays?: number;
}

export function validateOpenDisputeRequest(
  body: Record<string, unknown>,
  escrowIdParam?: string
): ValidationResult<OpenDisputeRequest> {
  if (!escrowIdParam || escrowIdParam.trim() === "") return { ok: false, error: missingField("escrowId") };
  const escrowId = escrowIdParam.trim();

  const initiatedBy = requireString(body, "initiatedBy");
  if (!initiatedBy.ok) return initiatedBy;

  const reason = requireString(body, "reason");
  if (!reason.ok) return reason;

  let slaDays: number | undefined;
  if (body.slaDays !== undefined && body.slaDays !== null) {
    if (typeof body.slaDays !== "number" || !Number.isFinite(body.slaDays) || body.slaDays <= 0) {
      return { ok: false, error: invalidField("slaDays", "slaDays must be a positive number when provided") };
    }
    slaDays = body.slaDays;
  }

  return { ok: true, value: { escrowId, initiatedBy: initiatedBy.value, reason: reason.value, slaDays } };
}

export interface SubmitEvidenceRequest {
  party: string;
  description: string;
  files: string[];
}

export function validateSubmitEvidenceRequest(body: Record<string, unknown>): ValidationResult<SubmitEvidenceRequest> {
  const party = requireString(body, "party");
  if (!party.ok) return party;

  const description = requireString(body, "description");
  if (!description.ok) return description;

  if (!Array.isArray(body.files) || body.files.length === 0 || !body.files.every((f) => typeof f === "string" && f.trim() !== "")) {
    return { ok: false, error: invalidField("files", "files must be a non-empty array of IPFS hashes or URLs") };
  }

  return { ok: true, value: { party: party.value, description: description.value, files: body.files } };
}

export interface AssignMediatorRequest {
  mediator: string;
  assignedBy?: string;
}

export function validateAssignMediatorRequest(body: Record<string, unknown>): ValidationResult<AssignMediatorRequest> {
  const mediator = requireString(body, "mediator");
  if (!mediator.ok) return mediator;

  let assignedBy: string | undefined;
  if (body.assignedBy !== undefined && body.assignedBy !== null) {
    const result = requireString(body, "assignedBy");
    if (!result.ok) return result;
    assignedBy = result.value;
  }

  return { ok: true, value: { mediator: mediator.value, assignedBy } };
}

export function validateMediationDecision(
  body: Record<string, unknown>,
  disputeIdParam?: string
): ValidationResult<MediationDecision> {
  if (!disputeIdParam || disputeIdParam.trim() === "") return { ok: false, error: missingField("disputeId") };
  const disputeId = disputeIdParam.trim();

  const decisionRaw = requireString(body, "decision");
  if (!decisionRaw.ok) return decisionRaw;
  if (!RESOLUTION_TYPES.includes(decisionRaw.value as ResolutionType)) {
    return {
      ok: false,
      error: invalidField("decision", `decision must be one of: ${RESOLUTION_TYPES.join(", ")}`),
    };
  }

  const buyerAmount = requireStroopsAmount(body, "buyerAmount");
  if (!buyerAmount.ok) return buyerAmount;

  const sellerAmount = requireStroopsAmount(body, "sellerAmount");
  if (!sellerAmount.ok) return sellerAmount;

  const reasoning = requireString(body, "reasoning");
  if (!reasoning.ok) return reasoning;

  const mediator = requireString(body, "mediator");
  if (!mediator.ok) return mediator;

  return {
    ok: true,
    value: {
      disputeId,
      decision: decisionRaw.value as ResolutionType,
      buyerAmount: buyerAmount.value,
      sellerAmount: sellerAmount.value,
      reasoning: reasoning.value,
      mediator: mediator.value,
    },
  };
}
