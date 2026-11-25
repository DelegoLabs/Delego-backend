/**
 * Tax Computation Types — Issue #505
 *
 * Server-side automated sales tax and VAT rate computation engine.
 * All monetary amounts use stroops (BigInt-safe integer strings) to avoid
 * floating-point rounding errors.
 */

/**
 * Item categories that affect which tax rules apply.
 * - `digital`         → EU/UK digital-services VAT rules (destination-based)
 * - `physical_goods`  → US destination-based sales tax + EU/UK standard VAT
 * - `service`         → EU/UK standard VAT; US generally non-taxable
 */
export type TaxItemCategory = "digital" | "physical_goods" | "service";

/**
 * Input parameters for the tax computation engine.
 * All country codes are ISO 3166-1 alpha-2 (e.g. "US", "DE", "GB").
 * Postal codes must match the convention of the given country.
 */
export interface TaxCalculationParams {
  buyerCountry: string;
  buyerPostalCode: string;
  merchantCountry: string;
  merchantPostalCode: string;
  itemCategory: TaxItemCategory;
  amountStroops: string;
  /** Optional: buyer VAT identification number for B2B reverse-charge checks. */
  buyerVatId?: string;
}

/**
 * Result returned by the tax computation engine.
 *
 * `taxRateBasisPoints` is the rate expressed in basis points so it can be
 * stored and compared without floating-point imprecision (2000 = 20.00%).
 * `taxAmountStroops` is always rounded down (floor) to the nearest stroop.
 */
export interface TaxCalculationResult {
  /** Human-readable jurisdiction label, e.g. "US-CA", "EU-DE", "UK". */
  taxJurisdiction: string;
  /** Tax rate in basis points (1 bp = 0.01%). e.g. 2000 for 20%. */
  taxRateBasisPoints: number;
  /** Tax amount in stroops, integer string, never fractional. */
  taxAmountStroops: string;
  /**
   * True when EU/UK B2B reverse charge applies: the tax rate is effectively 0
   * and the buyer self-accounts. Only set when buyerVatId passes format
   * validation.
   */
  isReverseCharge: boolean;
}

/**
 * A single entry in the tax rate lookup table.
 */
export interface TaxRateEntry {
  jurisdiction: string;
  /** Rate in basis points. */
  rateBasisPoints: number;
  /** Which item categories this entry covers. */
  categories: TaxItemCategory[];
}
