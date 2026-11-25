/**
 * Sales Tax & VAT Computation Engine — Issue #505 / #803
 *
 * Determines the correct tax jurisdiction and rate for a transaction, then
 * computes the tax amount using BigInt arithmetic to guarantee zero
 * floating-point rounding errors.
 *
 * Rules applied (in priority order):
 *
 *  1. EU/UK B2B reverse charge
 *     - Buyer is in an EU or UK country AND supplies a valid VAT ID
 *     → taxRateBasisPoints = 0, isReverseCharge = true
 *
 *  2. EU destination VAT
 *     - Buyer country is an EU member state
 *     → apply the destination-country standard VAT rate
 *
 *  3. UK VAT
 *     - Buyer country is GB
 *     → apply UK standard rate (20%)
 *
 *  4. US destination-based sales tax (physical_goods only)
 *     - Buyer country is US, itemCategory is "physical_goods"
 *     → resolve buyer state from ZIP code, apply state rate
 *     - "digital" and "service" are exempt from US sales tax (simplified)
 *
 *  5. Canadian GST / HST / PST / QST
 *     - Buyer country is CA
 *     → resolve province from postal code first letter, apply combined rate
 *     - HST provinces (ON, NB, NS, NL, PE): combined rate in one figure
 *     - QST provinces (QC): GST 5% + QST 9.975%
 *     - PST provinces (BC, MB, SK): GST 5% + PST
 *       BC PST is waived for digital services sold by non-resident vendors
 *     - GST-only (AB, NT, NU, YT): 5%
 *
 *  6. No tax
 *     - Any other country / unrecognised jurisdiction
 *     → taxRateBasisPoints = 0
 */

import type { TaxCalculationParams, TaxCalculationResult } from "@delegolabs/types";
import { createLogger } from "@delegolabs/utils";
import {
  euRateBps,
  isEuCountry,
  isUkCountry,
  usRateBps,
  caRateBps,
  UK_VAT_RATE_BPS,
} from "./rates.js";
import { isValidVatId } from "./vatId.js";

const log = createLogger("payments:tax-engine", process.env.LOG_LEVEL ?? "info");

/** 10 000 basis points = 100 %. */
const BASIS_POINTS_DIVISOR = 10_000n;

/**
 * Compute the tax amount for `amountStroops` at `rateBasisPoints` using
 * BigInt arithmetic. The result is floored to the nearest whole stroop,
 * guaranteeing zero floating-point rounding errors.
 *
 * @throws {RangeError} if `amountStroops` is not a valid non-negative integer string.
 * @throws {RangeError} if `rateBasisPoints` is negative or non-integer.
 */
export function computeTaxAmount(amountStroops: string, rateBasisPoints: number): string {
  if (!/^\d+$/.test(amountStroops.trim())) {
    throw new RangeError(
      `amountStroops must be a non-negative integer string, got: ${amountStroops}`,
    );
  }
  if (!Number.isInteger(rateBasisPoints) || rateBasisPoints < 0) {
    throw new RangeError(
      `rateBasisPoints must be a non-negative integer, got: ${rateBasisPoints}`,
    );
  }

  const amount = BigInt(amountStroops.trim());
  const rateBps = BigInt(rateBasisPoints);

  // floor( amount * rate / 10 000 )
  const taxAmount = (amount * rateBps) / BASIS_POINTS_DIVISOR;
  return taxAmount.toString();
}

function jurisdictionLabel(country: string, region?: string): string {
  return region ? `${country}-${region}` : country;
}

/**
 * Calculate the applicable tax for a transaction.
 *
 * All monetary values use stroops (non-negative integer strings).
 * No floating-point arithmetic is used anywhere in this function.
 */
export function calculateTax(params: TaxCalculationParams): TaxCalculationResult {
  const {
    buyerCountry,
    buyerPostalCode,
    itemCategory,
    amountStroops,
    buyerVatId,
  } = params;

  const country = buyerCountry.toUpperCase().trim();

  log.debug("calculateTax", { country, itemCategory, amountStroops });

  // ── 1. EU / UK B2B reverse charge ────────────────────────────────────────
  if (buyerVatId && (isEuCountry(country) || isUkCountry(country))) {
    if (isValidVatId(buyerVatId, country)) {
      log.debug("B2B reverse charge applied", { country, buyerVatId });
      return {
        taxJurisdiction: jurisdictionLabel(country),
        taxRateBasisPoints: 0,
        taxAmountStroops: "0",
        isReverseCharge: true,
      };
    }
    // VAT ID provided but failed format check — fall through to B2C rates.
    log.warn("buyerVatId failed format validation — treating as B2C", {
      country,
      buyerVatId,
    });
  }

  // ── 2. EU VAT (B2C) ───────────────────────────────────────────────────────
  if (isEuCountry(country)) {
    const rateBps = euRateBps(country) ?? 0;
    return {
      taxJurisdiction: jurisdictionLabel(country),
      taxRateBasisPoints: rateBps,
      taxAmountStroops: computeTaxAmount(amountStroops, rateBps),
      isReverseCharge: false,
    };
  }

  // ── 3. UK VAT ─────────────────────────────────────────────────────────────
  if (isUkCountry(country)) {
    return {
      taxJurisdiction: "GB",
      taxRateBasisPoints: UK_VAT_RATE_BPS,
      taxAmountStroops: computeTaxAmount(amountStroops, UK_VAT_RATE_BPS),
      isReverseCharge: false,
    };
  }

  // ── 4. US destination-based sales tax ────────────────────────────────────
  if (country === "US") {
    // Digital goods and services are generally not subject to US sales tax
    // in the majority of states (simplified rule per issue spec).
    if (itemCategory === "digital" || itemCategory === "service") {
      return {
        taxJurisdiction: "US-EXEMPT",
        taxRateBasisPoints: 0,
        taxAmountStroops: "0",
        isReverseCharge: false,
      };
    }

    const { state, bps } = usRateBps(buyerPostalCode);
    return {
      taxJurisdiction: jurisdictionLabel("US", state),
      taxRateBasisPoints: bps,
      taxAmountStroops: computeTaxAmount(amountStroops, bps),
      isReverseCharge: false,
    };
  }

  // ── 5. Canadian GST / HST / PST / QST ───────────────────────────────────
  if (country === "CA") {
    const { province, bps } = caRateBps(buyerPostalCode, itemCategory);
    return {
      taxJurisdiction: jurisdictionLabel("CA", province === "UNKNOWN" ? undefined : province),
      taxRateBasisPoints: bps,
      taxAmountStroops: computeTaxAmount(amountStroops, bps),
      isReverseCharge: false,
    };
  }

  // ── 6. No applicable tax ──────────────────────────────────────────────────
  return {
    taxJurisdiction: jurisdictionLabel(country),
    taxRateBasisPoints: 0,
    taxAmountStroops: "0",
    isReverseCharge: false,
  };
}
