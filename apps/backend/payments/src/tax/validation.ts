/**
 * Input validation for the tax computation endpoint — Issue #505
 */

import type { TaxCalculationParams, TaxItemCategory } from "@delegolabs/types";
import type { ValidationResult, ValidationError } from "../validation.js";

const ITEM_CATEGORIES: TaxItemCategory[] = ["digital", "physical_goods", "service"];

/** ISO 3166-1 alpha-2 country code (2 uppercase letters). */
const COUNTRY_RE = /^[A-Z]{2}$/;

/** Non-negative integer string. */
const STROOPS_RE = /^\d+$/;

function missingField(field: string): ValidationError {
  return { code: "VALIDATION_ERROR", message: `Missing required field: ${field}`, details: { field } };
}

function invalidField(field: string, message: string): ValidationError {
  return { code: "VALIDATION_ERROR", message, details: { field } };
}

function requireString(
  body: Record<string, unknown>,
  field: string,
): ValidationResult<string> {
  const val = body[field];
  if (val === undefined || val === null) return { ok: false, error: missingField(field) };
  if (typeof val !== "string" || val.trim() === "") {
    return { ok: false, error: invalidField(field, `${field} must be a non-empty string`) };
  }
  return { ok: true, value: val.trim() };
}

function requireCountry(
  body: Record<string, unknown>,
  field: string,
): ValidationResult<string> {
  const result = requireString(body, field);
  if (!result.ok) return result;
  const upper = result.value.toUpperCase();
  if (!COUNTRY_RE.test(upper)) {
    return {
      ok: false,
      error: invalidField(field, `${field} must be an ISO 3166-1 alpha-2 country code (e.g. "US", "DE")`),
    };
  }
  return { ok: true, value: upper };
}

export function validateTaxCalculationParams(
  body: Record<string, unknown>,
): ValidationResult<TaxCalculationParams> {
  const buyerCountry = requireCountry(body, "buyerCountry");
  if (!buyerCountry.ok) return buyerCountry;

  const buyerPostalCode = requireString(body, "buyerPostalCode");
  if (!buyerPostalCode.ok) return buyerPostalCode;

  const merchantCountry = requireCountry(body, "merchantCountry");
  if (!merchantCountry.ok) return merchantCountry;

  const merchantPostalCode = requireString(body, "merchantPostalCode");
  if (!merchantPostalCode.ok) return merchantPostalCode;

  const categoryRaw = requireString(body, "itemCategory");
  if (!categoryRaw.ok) return categoryRaw;
  if (!(ITEM_CATEGORIES as string[]).includes(categoryRaw.value)) {
    return {
      ok: false,
      error: invalidField(
        "itemCategory",
        `itemCategory must be one of: ${ITEM_CATEGORIES.join(", ")}`,
      ),
    };
  }

  const amountStroops = requireString(body, "amountStroops");
  if (!amountStroops.ok) return amountStroops;
  if (!STROOPS_RE.test(amountStroops.value)) {
    return {
      ok: false,
      error: invalidField("amountStroops", "amountStroops must be a non-negative integer string"),
    };
  }

  const result: TaxCalculationParams = {
    buyerCountry: buyerCountry.value,
    buyerPostalCode: buyerPostalCode.value,
    merchantCountry: merchantCountry.value,
    merchantPostalCode: merchantPostalCode.value,
    itemCategory: categoryRaw.value as TaxItemCategory,
    amountStroops: amountStroops.value,
  };

  // Optional: buyerVatId
  if (body.buyerVatId !== undefined && body.buyerVatId !== null) {
    if (typeof body.buyerVatId !== "string" || body.buyerVatId.trim() === "") {
      return {
        ok: false,
        error: invalidField("buyerVatId", "buyerVatId must be a non-empty string when provided"),
      };
    }
    result.buyerVatId = body.buyerVatId.trim();
  }

  return { ok: true, value: result };
}
