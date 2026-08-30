/**
 * Request validation for the subscription endpoints (Issue #47). Mirrors the
 * `ValidationResult<T>` convention used by `../validation.ts` and
 * `../disputes/validation.ts`.
 */

import { isValidStellarAddress } from "../../escrow/config.js";
import type { BillingInterval, CreateSubscriptionInput, CreateSubscriptionPlanInput } from "./types.js";

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

function requireStellarAddress(body: Record<string, unknown>, field: string): ValidationResult<string> {
  const str = requireString(body, field);
  if (!str.ok) return str;
  if (!isValidStellarAddress(str.value)) {
    return { ok: false, error: invalidField(field, `${field} must be a valid Stellar account address`) };
  }
  return str;
}

const BILLING_INTERVALS: BillingInterval[] = ["day", "week", "month", "year"];

export function validateCreatePlanRequest(
  body: Record<string, unknown>
): ValidationResult<CreateSubscriptionPlanInput> {
  const merchantId = requireStellarAddress(body, "merchantId");
  if (!merchantId.ok) return merchantId;

  const name = requireString(body, "name");
  if (!name.ok) return name;

  const amount = requireStroopsAmount(body, "amount");
  if (!amount.ok) return amount;

  const currency = requireString(body, "currency");
  if (!currency.ok) return currency;

  const intervalRaw = requireString(body, "interval");
  if (!intervalRaw.ok) return intervalRaw;
  if (!BILLING_INTERVALS.includes(intervalRaw.value as BillingInterval)) {
    return { ok: false, error: invalidField("interval", `interval must be one of: ${BILLING_INTERVALS.join(", ")}`) };
  }

  let intervalCount: number | undefined;
  if (body.intervalCount !== undefined && body.intervalCount !== null) {
    if (typeof body.intervalCount !== "number" || !Number.isInteger(body.intervalCount) || body.intervalCount <= 0) {
      return { ok: false, error: invalidField("intervalCount", "intervalCount must be a positive integer") };
    }
    intervalCount = body.intervalCount;
  }

  let trialDays: number | undefined;
  if (body.trialDays !== undefined && body.trialDays !== null) {
    if (typeof body.trialDays !== "number" || !Number.isInteger(body.trialDays) || body.trialDays < 0) {
      return { ok: false, error: invalidField("trialDays", "trialDays must be a non-negative integer") };
    }
    trialDays = body.trialDays;
  }

  let maxAmount: string | undefined;
  if (body.maxAmount !== undefined && body.maxAmount !== null) {
    const parsed = requireStroopsAmount(body, "maxAmount");
    if (!parsed.ok) return parsed;
    maxAmount = parsed.value;
  }

  return {
    ok: true,
    value: {
      merchantId: merchantId.value,
      name: name.value,
      description: typeof body.description === "string" ? body.description : undefined,
      amount: amount.value,
      currency: currency.value,
      interval: intervalRaw.value as BillingInterval,
      intervalCount,
      trialDays,
      usageBased: body.usageBased === true,
      maxAmount,
      metadata: (body.metadata as Record<string, unknown>) ?? undefined,
    },
  };
}

export function validateCreateSubscriptionRequest(
  body: Record<string, unknown>
): ValidationResult<CreateSubscriptionInput> {
  const planId = requireString(body, "planId");
  if (!planId.ok) return planId;

  const buyerAddress = requireStellarAddress(body, "buyerAddress");
  if (!buyerAddress.ok) return buyerAddress;

  const sellerAddress = requireStellarAddress(body, "sellerAddress");
  if (!sellerAddress.ok) return sellerAddress;

  const paymentMethodRaw = body.paymentMethod;
  if (typeof paymentMethodRaw !== "object" || paymentMethodRaw === null) {
    return { ok: false, error: missingField("paymentMethod") };
  }
  const paymentMethod = paymentMethodRaw as Record<string, unknown>;
  if (paymentMethod.type !== "escrow" && paymentMethod.type !== "wallet") {
    return { ok: false, error: invalidField("paymentMethod.type", "paymentMethod.type must be 'escrow' or 'wallet'") };
  }
  if (paymentMethod.escrowContractId !== undefined && typeof paymentMethod.escrowContractId !== "string") {
    return { ok: false, error: invalidField("paymentMethod.escrowContractId", "must be a string when provided") };
  }

  let trialDaysOverride: number | undefined;
  if (body.trialDaysOverride !== undefined && body.trialDaysOverride !== null) {
    if (typeof body.trialDaysOverride !== "number" || !Number.isInteger(body.trialDaysOverride) || body.trialDaysOverride < 0) {
      return { ok: false, error: invalidField("trialDaysOverride", "trialDaysOverride must be a non-negative integer") };
    }
    trialDaysOverride = body.trialDaysOverride;
  }

  return {
    ok: true,
    value: {
      planId: planId.value,
      buyerAddress: buyerAddress.value,
      sellerAddress: sellerAddress.value,
      paymentMethod: {
        type: paymentMethod.type,
        escrowContractId: paymentMethod.escrowContractId as string | undefined,
      },
      metadata: (body.metadata as Record<string, unknown>) ?? undefined,
      trialDaysOverride,
    },
  };
}

export function validateCancelSubscriptionRequest(
  body: Record<string, unknown>
): ValidationResult<{ atPeriodEnd: boolean }> {
  if (body.atPeriodEnd !== undefined && typeof body.atPeriodEnd !== "boolean") {
    return { ok: false, error: invalidField("atPeriodEnd", "atPeriodEnd must be a boolean when provided") };
  }
  return { ok: true, value: { atPeriodEnd: body.atPeriodEnd === true } };
}

export function validateChangePlanRequest(body: Record<string, unknown>): ValidationResult<{ planId: string }> {
  const planId = requireString(body, "planId");
  if (!planId.ok) return planId;
  return { ok: true, value: { planId: planId.value } };
}

export function validateRenewRequest(body: Record<string, unknown>): ValidationResult<{ usageAmount?: string }> {
  if (body.usageAmount === undefined || body.usageAmount === null) {
    return { ok: true, value: {} };
  }
  const parsed = requireStroopsAmount(body, "usageAmount");
  if (!parsed.ok) return parsed;
  return { ok: true, value: { usageAmount: parsed.value } };
}
