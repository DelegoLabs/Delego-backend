/**
 * Comprehensive test suite for the Sales Tax & VAT Computation Engine
 * Issue #505
 *
 * Coverage:
 *  - computeTaxAmount: BigInt precision, edge values
 *  - US destination-based sales tax (all physical_goods paths + exempt categories)
 *  - EU VAT (B2C rates for representative member states)
 *  - EU B2B reverse charge (valid + invalid VAT IDs)
 *  - UK VAT (B2C + reverse charge)
 *  - No-tax jurisdictions
 *  - validateTaxCalculationParams: required fields, bad country codes, bad amounts
 *  - isValidVatId: format acceptance and rejection per country
 */

import { describe, it, expect } from "vitest";
import { calculateTax, computeTaxAmount } from "./engine.js";
import { isValidVatId } from "./vatId.js";
import { validateTaxCalculationParams } from "./validation.js";
import { usStateFromPostalCode, US_STATE_RATES, EU_VAT_RATES, caProvinceFromPostalCode, CA_PROVINCE_RATES } from "./rates.js";
import type { TaxCalculationParams } from "@delegolabs/types";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function params(overrides: Partial<TaxCalculationParams> = {}): TaxCalculationParams {
  return {
    buyerCountry: "US",
    buyerPostalCode: "90210", // CA
    merchantCountry: "US",
    merchantPostalCode: "10001",
    itemCategory: "physical_goods",
    amountStroops: "1000000", // 0.1 XLM in stroops
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// computeTaxAmount — BigInt precision
// ---------------------------------------------------------------------------

describe("computeTaxAmount", () => {
  it("returns '0' for zero rate", () => {
    expect(computeTaxAmount("1000000", 0)).toBe("0");
  });

  it("returns exact integer for clean division (20% of 1 000 000)", () => {
    // 1 000 000 * 2000 / 10 000 = 200 000
    expect(computeTaxAmount("1000000", 2000)).toBe("200000");
  });

  it("floors the result — no rounding up", () => {
    // 10 000 * 725 / 10 000 = 725 exactly
    expect(computeTaxAmount("10000", 725)).toBe("725");
    // 10 001 * 725 / 10 000 = 725.0725 → floor → 725
    expect(computeTaxAmount("10001", 725)).toBe("725");
  });

  it("handles very large stroop amounts without overflow", () => {
    // Max XLM supply ≈ 50 billion * 10^7 stroops = 5e17
    const big = "500000000000000000"; // 5e17
    // 20% = 2000 bps → 1e17
    expect(computeTaxAmount(big, 2000)).toBe("100000000000000000");
  });

  it("handles zero amount", () => {
    expect(computeTaxAmount("0", 2000)).toBe("0");
  });

  it("throws RangeError for non-integer stroop string", () => {
    expect(() => computeTaxAmount("100.5", 2000)).toThrow(RangeError);
    expect(() => computeTaxAmount("abc", 2000)).toThrow(RangeError);
    expect(() => computeTaxAmount("-100", 2000)).toThrow(RangeError);
  });

  it("throws RangeError for negative rateBasisPoints", () => {
    expect(() => computeTaxAmount("1000", -1)).toThrow(RangeError);
  });
});

// ---------------------------------------------------------------------------
// US destination-based sales tax
// ---------------------------------------------------------------------------

describe("calculateTax — US physical_goods", () => {
  it("applies California rate (7.25%) for CA ZIP 90210", () => {
    const result = calculateTax(params({ buyerPostalCode: "90210" }));
    expect(result.taxJurisdiction).toBe("US-CA");
    expect(result.taxRateBasisPoints).toBe(US_STATE_RATES["CA"]);
    // 1 000 000 * 725 / 10 000 = 72 500
    expect(result.taxAmountStroops).toBe("72500");
    expect(result.isReverseCharge).toBe(false);
  });

  it("applies Texas rate (6.25%) for TX ZIP 75201", () => {
    const result = calculateTax(params({ buyerPostalCode: "75201" }));
    expect(result.taxJurisdiction).toBe("US-TX");
    expect(result.taxRateBasisPoints).toBe(625);
    // 1 000 000 * 625 / 10 000 = 62 500
    expect(result.taxAmountStroops).toBe("62500");
  });

  it("applies New York rate (4%) for NY ZIP 10001", () => {
    const result = calculateTax(params({ buyerPostalCode: "10001" }));
    expect(result.taxJurisdiction).toBe("US-NY");
    expect(result.taxRateBasisPoints).toBe(400);
    expect(result.taxAmountStroops).toBe("40000");
  });

  it("returns 0% for Oregon (no state sales tax) ZIP 97201", () => {
    const result = calculateTax(params({ buyerPostalCode: "97201" }));
    expect(result.taxJurisdiction).toBe("US-OR");
    expect(result.taxRateBasisPoints).toBe(0);
    expect(result.taxAmountStroops).toBe("0");
  });

  it("returns 0% for Delaware (no state sales tax) ZIP 19801", () => {
    const result = calculateTax(params({ buyerPostalCode: "19801" }));
    expect(result.taxRateBasisPoints).toBe(0);
    expect(result.taxAmountStroops).toBe("0");
  });

  it("applies Florida rate for FL ZIP 33101", () => {
    const result = calculateTax(params({ buyerPostalCode: "33101" }));
    expect(result.taxJurisdiction).toBe("US-FL");
    expect(result.taxRateBasisPoints).toBe(600);
  });

  it("applies Tennessee rate (7%) for TN ZIP 37201", () => {
    const result = calculateTax(params({ buyerPostalCode: "37201" }));
    expect(result.taxJurisdiction).toBe("US-TN");
    expect(result.taxRateBasisPoints).toBe(700);
  });
});

describe("calculateTax — US digital/service (exempt)", () => {
  it("exempts digital goods from US sales tax", () => {
    const result = calculateTax(params({ itemCategory: "digital" }));
    expect(result.taxJurisdiction).toBe("US-EXEMPT");
    expect(result.taxRateBasisPoints).toBe(0);
    expect(result.taxAmountStroops).toBe("0");
    expect(result.isReverseCharge).toBe(false);
  });

  it("exempts services from US sales tax", () => {
    const result = calculateTax(params({ itemCategory: "service" }));
    expect(result.taxJurisdiction).toBe("US-EXEMPT");
    expect(result.taxRateBasisPoints).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// EU VAT — B2C
// ---------------------------------------------------------------------------

describe("calculateTax — EU VAT (B2C)", () => {
  it("applies German VAT 19% for DE buyer", () => {
    const result = calculateTax(params({
      buyerCountry: "DE",
      buyerPostalCode: "10115",
      itemCategory: "digital",
    }));
    expect(result.taxJurisdiction).toBe("DE");
    expect(result.taxRateBasisPoints).toBe(EU_VAT_RATES["DE"]); // 1900
    // 1 000 000 * 1900 / 10 000 = 190 000
    expect(result.taxAmountStroops).toBe("190000");
    expect(result.isReverseCharge).toBe(false);
  });

  it("applies French VAT 20% for FR buyer", () => {
    const result = calculateTax(params({
      buyerCountry: "FR",
      buyerPostalCode: "75001",
      itemCategory: "physical_goods",
    }));
    expect(result.taxJurisdiction).toBe("FR");
    expect(result.taxRateBasisPoints).toBe(2000);
    expect(result.taxAmountStroops).toBe("200000");
  });

  it("applies Danish VAT 25% for DK buyer", () => {
    const result = calculateTax(params({
      buyerCountry: "DK",
      buyerPostalCode: "1000",
      itemCategory: "service",
    }));
    expect(result.taxJurisdiction).toBe("DK");
    expect(result.taxRateBasisPoints).toBe(2500);
  });

  it("applies Hungarian VAT 27% for HU buyer", () => {
    const result = calculateTax(params({
      buyerCountry: "HU",
      buyerPostalCode: "1011",
      itemCategory: "digital",
    }));
    expect(result.taxJurisdiction).toBe("HU");
    expect(result.taxRateBasisPoints).toBe(2700);
  });

  it("applies Luxembourg VAT 17% for LU buyer", () => {
    const result = calculateTax(params({
      buyerCountry: "LU",
      buyerPostalCode: "1000",
      itemCategory: "digital",
    }));
    expect(result.taxJurisdiction).toBe("LU");
    expect(result.taxRateBasisPoints).toBe(1700);
  });

  it("applies Spanish VAT 21% for ES buyer", () => {
    const result = calculateTax(params({
      buyerCountry: "ES",
      buyerPostalCode: "28001",
      itemCategory: "physical_goods",
    }));
    expect(result.taxJurisdiction).toBe("ES");
    expect(result.taxRateBasisPoints).toBe(2100);
  });

  it("applies Italy VAT 22% for IT buyer", () => {
    const result = calculateTax(params({
      buyerCountry: "IT",
      buyerPostalCode: "00100",
      itemCategory: "digital",
    }));
    expect(result.taxJurisdiction).toBe("IT");
    expect(result.taxRateBasisPoints).toBe(2200);
  });

  it("tax amount is exactly floor(amount * rate / 10000) with no rounding error", () => {
    // 999_999 * 1900 / 10000 = 189999.81 → floor → 189999
    const result = calculateTax(params({
      buyerCountry: "DE",
      buyerPostalCode: "10115",
      amountStroops: "999999",
      itemCategory: "digital",
    }));
    expect(result.taxAmountStroops).toBe("189999");
  });
});

// ---------------------------------------------------------------------------
// EU B2B reverse charge
// ---------------------------------------------------------------------------

describe("calculateTax — EU B2B reverse charge", () => {
  it("applies reverse charge for valid German VAT ID", () => {
    const result = calculateTax(params({
      buyerCountry: "DE",
      buyerPostalCode: "10115",
      itemCategory: "digital",
      buyerVatId: "DE123456789",
    }));
    expect(result.taxRateBasisPoints).toBe(0);
    expect(result.taxAmountStroops).toBe("0");
    expect(result.isReverseCharge).toBe(true);
    expect(result.taxJurisdiction).toBe("DE");
  });

  it("applies reverse charge for valid French VAT ID", () => {
    const result = calculateTax(params({
      buyerCountry: "FR",
      buyerPostalCode: "75001",
      itemCategory: "physical_goods",
      buyerVatId: "FR12345678901",
    }));
    expect(result.isReverseCharge).toBe(true);
    expect(result.taxAmountStroops).toBe("0");
  });

  it("falls back to B2C rate when VAT ID format is invalid", () => {
    const result = calculateTax(params({
      buyerCountry: "DE",
      buyerPostalCode: "10115",
      itemCategory: "digital",
      buyerVatId: "DE-INVALID",
    }));
    // Should fall through to normal DE VAT
    expect(result.isReverseCharge).toBe(false);
    expect(result.taxRateBasisPoints).toBe(1900);
  });

  it("does not apply reverse charge when no buyerVatId is provided", () => {
    const result = calculateTax(params({
      buyerCountry: "NL",
      buyerPostalCode: "1000",
      itemCategory: "service",
    }));
    expect(result.isReverseCharge).toBe(false);
    expect(result.taxRateBasisPoints).toBe(EU_VAT_RATES["NL"]); // 2100
  });

  it("does not apply reverse charge for US buyer with VAT ID", () => {
    // B2B reverse charge only applies to EU/UK buyers
    const result = calculateTax(params({
      buyerCountry: "US",
      buyerPostalCode: "90210",
      itemCategory: "physical_goods",
      buyerVatId: "DE123456789",
    }));
    expect(result.isReverseCharge).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// UK VAT
// ---------------------------------------------------------------------------

describe("calculateTax — UK VAT", () => {
  it("applies 20% UK VAT for GB buyer (B2C)", () => {
    const result = calculateTax(params({
      buyerCountry: "GB",
      buyerPostalCode: "SW1A 1AA",
      itemCategory: "digital",
    }));
    expect(result.taxJurisdiction).toBe("GB");
    expect(result.taxRateBasisPoints).toBe(2000);
    expect(result.taxAmountStroops).toBe("200000");
    expect(result.isReverseCharge).toBe(false);
  });

  it("applies UK reverse charge for valid GB VAT number", () => {
    const result = calculateTax(params({
      buyerCountry: "GB",
      buyerPostalCode: "EC1A 1BB",
      itemCategory: "physical_goods",
      buyerVatId: "GB123456789",
    }));
    expect(result.isReverseCharge).toBe(true);
    expect(result.taxRateBasisPoints).toBe(0);
    expect(result.taxAmountStroops).toBe("0");
  });

  it("falls back to 20% when GB VAT ID is malformed", () => {
    const result = calculateTax(params({
      buyerCountry: "GB",
      buyerPostalCode: "EC1A 1BB",
      itemCategory: "physical_goods",
      buyerVatId: "GB-BADFORMAT",
    }));
    expect(result.isReverseCharge).toBe(false);
    expect(result.taxRateBasisPoints).toBe(2000);
  });
});

// ---------------------------------------------------------------------------
// No-tax jurisdictions
// ---------------------------------------------------------------------------

describe("calculateTax — no-tax jurisdictions", () => {
  it("returns 0% for Japan buyer", () => {
    const result = calculateTax(params({ buyerCountry: "JP", buyerPostalCode: "100-0001" }));
    expect(result.taxRateBasisPoints).toBe(0);
    expect(result.taxAmountStroops).toBe("0");
    expect(result.isReverseCharge).toBe(false);
  });

  it("returns 0% for Australian buyer", () => {
    const result = calculateTax(params({ buyerCountry: "AU", buyerPostalCode: "2000" }));
    expect(result.taxRateBasisPoints).toBe(0);
  });

  it("returns 0% for Singapore buyer", () => {
    const result = calculateTax(params({ buyerCountry: "SG", buyerPostalCode: "018956" }));
    expect(result.taxRateBasisPoints).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// VAT ID format validation
// ---------------------------------------------------------------------------

describe("isValidVatId", () => {
  describe("Germany (DE)", () => {
    it("accepts valid DE VAT ID", () => expect(isValidVatId("DE123456789", "DE")).toBe(true));
    it("accepts valid without prefix", () => expect(isValidVatId("123456789", "DE")).toBe(true));
    it("rejects too short", () => expect(isValidVatId("DE12345678", "DE")).toBe(false));
    it("rejects too long", () => expect(isValidVatId("DE1234567890", "DE")).toBe(false));
    it("rejects letters in body", () => expect(isValidVatId("DE12345678A", "DE")).toBe(false));
  });

  describe("France (FR)", () => {
    it("accepts FR12345678901", () => expect(isValidVatId("FR12345678901", "FR")).toBe(true));
    it("accepts FRA1234567890 (alpha chars)", () => expect(isValidVatId("FRA1234567890", "FR")).toBe(true));
    it("rejects body too short", () => expect(isValidVatId("FR1234567", "FR")).toBe(false));
  });

  describe("Netherlands (NL)", () => {
    it("accepts NL123456789B01", () => expect(isValidVatId("NL123456789B01", "NL")).toBe(true));
    it("rejects without B", () => expect(isValidVatId("NL12345678901", "NL")).toBe(false));
  });

  describe("United Kingdom (GB)", () => {
    it("accepts GB123456789", () => expect(isValidVatId("GB123456789", "GB")).toBe(true));
    it("accepts GB123456789012", () => expect(isValidVatId("GB123456789012", "GB")).toBe(true));
    it("accepts GD123 (government)", () => expect(isValidVatId("GBGD123", "GB")).toBe(true));
    it("rejects GBINVALID", () => expect(isValidVatId("GBINVALID", "GB")).toBe(false));
  });

  describe("Spain (ES)", () => {
    it("accepts ESA1234567B", () => expect(isValidVatId("ESA1234567B", "ES")).toBe(true));
    it("accepts ES12345678A", () => expect(isValidVatId("ES12345678A", "ES")).toBe(true));
    it("rejects too short body", () => expect(isValidVatId("ES1234567", "ES")).toBe(false));
  });

  describe("Austria (AT)", () => {
    it("accepts ATU12345678", () => expect(isValidVatId("ATU12345678", "AT")).toBe(true));
    it("rejects without U prefix in body", () => expect(isValidVatId("AT123456789", "AT")).toBe(false));
  });

  describe("Sweden (SE)", () => {
    it("accepts SE123456789012", () => expect(isValidVatId("SE123456789012", "SE")).toBe(true));
    it("rejects 11-digit body", () => expect(isValidVatId("SE12345678901", "SE")).toBe(false));
  });

  describe("mismatched country prefix", () => {
    it("rejects DE VAT number with FR country code", () => {
      expect(isValidVatId("DE123456789", "FR")).toBe(false);
    });
  });
});

// ---------------------------------------------------------------------------
// usStateFromPostalCode
// ---------------------------------------------------------------------------

describe("usStateFromPostalCode", () => {
  it("maps 90210 → CA", () => expect(usStateFromPostalCode("90210")).toBe("CA"));
  it("maps 10001 → NY", () => expect(usStateFromPostalCode("10001")).toBe("NY"));
  it("maps 75201 → TX", () => expect(usStateFromPostalCode("75201")).toBe("TX"));
  it("maps 60601 → IL", () => expect(usStateFromPostalCode("60601")).toBe("IL"));
  it("maps 97201 → OR", () => expect(usStateFromPostalCode("97201")).toBe("OR"));
  it("maps 02110 → MA", () => expect(usStateFromPostalCode("02110")).toBe("MA"));
  it("returns null for non-US-formatted code", () => expect(usStateFromPostalCode("SW1A1AA")).toBeNull());
  it("returns null for empty string", () => expect(usStateFromPostalCode("")).toBeNull());
});

// ---------------------------------------------------------------------------
// Canadian GST / HST / PST / QST
// ---------------------------------------------------------------------------

describe("caProvinceFromPostalCode", () => {
  it("maps M5V 3A8 → ON (Toronto)", () => expect(caProvinceFromPostalCode("M5V 3A8")).toBe("ON"));
  it("maps H3B 2Y3 → QC (Montréal)", () => expect(caProvinceFromPostalCode("H3B 2Y3")).toBe("QC"));
  it("maps V6B 1A1 → BC (Vancouver)", () => expect(caProvinceFromPostalCode("V6B 1A1")).toBe("BC"));
  it("maps T2P 1J9 → AB (Calgary)", () => expect(caProvinceFromPostalCode("T2P 1J9")).toBe("AB"));
  it("maps R3C 4A5 → MB (Winnipeg)", () => expect(caProvinceFromPostalCode("R3C 4A5")).toBe("MB"));
  it("maps S4P 3Y2 → SK (Regina)", () => expect(caProvinceFromPostalCode("S4P 3Y2")).toBe("SK"));
  it("maps B3H 4R2 → NS (Halifax)", () => expect(caProvinceFromPostalCode("B3H 4R2")).toBe("NS"));
  it("maps E1C 1B9 → NB (Moncton)", () => expect(caProvinceFromPostalCode("E1C 1B9")).toBe("NB"));
  it("maps A1C 1A1 → NL (St. John's)", () => expect(caProvinceFromPostalCode("A1C 1A1")).toBe("NL"));
  it("maps C1A 4P3 → PE (Charlottetown)", () => expect(caProvinceFromPostalCode("C1A 4P3")).toBe("PE"));
  it("maps X1A 2N5 → NT (Yellowknife)", () => expect(caProvinceFromPostalCode("X1A 2N5")).toBe("NT"));
  it("maps Y1A 1C2 → YT (Whitehorse)", () => expect(caProvinceFromPostalCode("Y1A 1C2")).toBe("YT"));
  it("returns null for a US ZIP code", () => expect(caProvinceFromPostalCode("90210")).toBeNull());
  it("returns null for empty string", () => expect(caProvinceFromPostalCode("")).toBeNull());
  it("accepts postal code without space (M5V3A8)", () => expect(caProvinceFromPostalCode("M5V3A8")).toBe("ON"));
});

describe("calculateTax — Canada physical_goods", () => {
  it("applies ON HST 13% for Ontario postal code M5V 3A8", () => {
    const result = calculateTax(params({
      buyerCountry: "CA",
      buyerPostalCode: "M5V 3A8",
      itemCategory: "physical_goods",
    }));
    expect(result.taxJurisdiction).toBe("CA-ON");
    expect(result.taxRateBasisPoints).toBe(1300);
    // 1 000 000 * 1300 / 10 000 = 130 000
    expect(result.taxAmountStroops).toBe("130000");
    expect(result.isReverseCharge).toBe(false);
  });

  it("applies QC GST+QST (~14.975%) for Quebec postal code H3B 2Y3", () => {
    const result = calculateTax(params({
      buyerCountry: "CA",
      buyerPostalCode: "H3B 2Y3",
      itemCategory: "physical_goods",
    }));
    expect(result.taxJurisdiction).toBe("CA-QC");
    // 500 (GST) + 997 (QST floored) = 1497 bps
    expect(result.taxRateBasisPoints).toBe(1497);
    // 1 000 000 * 1497 / 10 000 = 149 700
    expect(result.taxAmountStroops).toBe("149700");
    expect(result.isReverseCharge).toBe(false);
  });

  it("applies BC GST+PST 12% for British Columbia postal code V6B 1A1", () => {
    const result = calculateTax(params({
      buyerCountry: "CA",
      buyerPostalCode: "V6B 1A1",
      itemCategory: "physical_goods",
    }));
    expect(result.taxJurisdiction).toBe("CA-BC");
    expect(result.taxRateBasisPoints).toBe(1200); // 500 + 700
    // 1 000 000 * 1200 / 10 000 = 120 000
    expect(result.taxAmountStroops).toBe("120000");
  });

  it("applies AB GST-only 5% for Alberta postal code T2P 1J9", () => {
    const result = calculateTax(params({
      buyerCountry: "CA",
      buyerPostalCode: "T2P 1J9",
      itemCategory: "physical_goods",
    }));
    expect(result.taxJurisdiction).toBe("CA-AB");
    expect(result.taxRateBasisPoints).toBe(500);
    expect(result.taxAmountStroops).toBe("50000");
  });

  it("applies MB GST+PST 12% for Manitoba postal code R3C 4A5", () => {
    const result = calculateTax(params({
      buyerCountry: "CA",
      buyerPostalCode: "R3C 4A5",
      itemCategory: "physical_goods",
    }));
    expect(result.taxJurisdiction).toBe("CA-MB");
    expect(result.taxRateBasisPoints).toBe(1200); // 500 + 700
  });

  it("applies SK GST+PST 11% for Saskatchewan postal code S4P 3Y2", () => {
    const result = calculateTax(params({
      buyerCountry: "CA",
      buyerPostalCode: "S4P 3Y2",
      itemCategory: "physical_goods",
    }));
    expect(result.taxJurisdiction).toBe("CA-SK");
    expect(result.taxRateBasisPoints).toBe(1100); // 500 + 600
  });

  it("applies NS HST 15% for Nova Scotia postal code B3H 4R2", () => {
    const result = calculateTax(params({
      buyerCountry: "CA",
      buyerPostalCode: "B3H 4R2",
      itemCategory: "physical_goods",
    }));
    expect(result.taxJurisdiction).toBe("CA-NS");
    expect(result.taxRateBasisPoints).toBe(1500);
    expect(result.taxAmountStroops).toBe("150000");
  });

  it("applies NB HST 15% for New Brunswick postal code E1C 1B9", () => {
    const result = calculateTax(params({
      buyerCountry: "CA",
      buyerPostalCode: "E1C 1B9",
      itemCategory: "physical_goods",
    }));
    expect(result.taxJurisdiction).toBe("CA-NB");
    expect(result.taxRateBasisPoints).toBe(1500);
  });

  it("applies NL HST 15% for Newfoundland postal code A1C 1A1", () => {
    const result = calculateTax(params({
      buyerCountry: "CA",
      buyerPostalCode: "A1C 1A1",
      itemCategory: "physical_goods",
    }));
    expect(result.taxJurisdiction).toBe("CA-NL");
    expect(result.taxRateBasisPoints).toBe(1500);
  });

  it("applies PE HST 15% for PEI postal code C1A 4P3", () => {
    const result = calculateTax(params({
      buyerCountry: "CA",
      buyerPostalCode: "C1A 4P3",
      itemCategory: "physical_goods",
    }));
    expect(result.taxJurisdiction).toBe("CA-PE");
    expect(result.taxRateBasisPoints).toBe(1500);
  });

  it("applies NT GST-only 5% for Northwest Territories postal code X1A 2N5", () => {
    const result = calculateTax(params({
      buyerCountry: "CA",
      buyerPostalCode: "X1A 2N5",
      itemCategory: "physical_goods",
    }));
    expect(result.taxJurisdiction).toBe("CA-NT");
    expect(result.taxRateBasisPoints).toBe(500);
  });

  it("tax amount is floor(amount * rate / 10000) for QC fractional rate", () => {
    // 999 999 * 1497 / 10 000 = 149699.8503 → floor → 149699
    const result = calculateTax(params({
      buyerCountry: "CA",
      buyerPostalCode: "H3B 2Y3",
      itemCategory: "physical_goods",
      amountStroops: "999999",
    }));
    expect(result.taxAmountStroops).toBe("149699");
  });
});

describe("calculateTax — Canada digital services", () => {
  it("applies ON HST 13% for digital goods in Ontario", () => {
    const result = calculateTax(params({
      buyerCountry: "CA",
      buyerPostalCode: "M5V 3A8",
      itemCategory: "digital",
    }));
    expect(result.taxJurisdiction).toBe("CA-ON");
    expect(result.taxRateBasisPoints).toBe(1300);
    expect(result.taxAmountStroops).toBe("130000");
  });

  it("applies BC GST-only 5% for digital services (BC PST waived for digital)", () => {
    const result = calculateTax(params({
      buyerCountry: "CA",
      buyerPostalCode: "V6B 1A1",
      itemCategory: "digital",
    }));
    expect(result.taxJurisdiction).toBe("CA-BC");
    // BC PST exempt for digital → only federal GST 5%
    expect(result.taxRateBasisPoints).toBe(500);
    expect(result.taxAmountStroops).toBe("50000");
  });

  it("applies QC GST+QST for digital services in Quebec", () => {
    const result = calculateTax(params({
      buyerCountry: "CA",
      buyerPostalCode: "H3B 2Y3",
      itemCategory: "digital",
    }));
    expect(result.taxJurisdiction).toBe("CA-QC");
    // QST applies to digital services
    expect(result.taxRateBasisPoints).toBe(1497);
  });

  it("applies AB GST-only 5% for digital services in Alberta", () => {
    const result = calculateTax(params({
      buyerCountry: "CA",
      buyerPostalCode: "T2P 1J9",
      itemCategory: "digital",
    }));
    expect(result.taxJurisdiction).toBe("CA-AB");
    expect(result.taxRateBasisPoints).toBe(500);
  });

  it("applies SK GST+PST 11% for digital services in Saskatchewan", () => {
    const result = calculateTax(params({
      buyerCountry: "CA",
      buyerPostalCode: "S4P 3Y2",
      itemCategory: "digital",
    }));
    expect(result.taxJurisdiction).toBe("CA-SK");
    expect(result.taxRateBasisPoints).toBe(1100);
  });

  it("applies MB GST+PST 12% for digital services in Manitoba", () => {
    const result = calculateTax(params({
      buyerCountry: "CA",
      buyerPostalCode: "R3C 4A5",
      itemCategory: "digital",
    }));
    expect(result.taxJurisdiction).toBe("CA-MB");
    expect(result.taxRateBasisPoints).toBe(1200);
  });
});

describe("calculateTax — Canada services", () => {
  it("applies ON HST 13% for services in Ontario", () => {
    const result = calculateTax(params({
      buyerCountry: "CA",
      buyerPostalCode: "M5V 3A8",
      itemCategory: "service",
    }));
    expect(result.taxJurisdiction).toBe("CA-ON");
    expect(result.taxRateBasisPoints).toBe(1300);
  });

  it("applies BC GST+PST 12% for services in British Columbia", () => {
    // Services in BC: PST applies to services differently, but for simplicity
    // BC service is treated same as physical_goods (non-digital)
    const result = calculateTax(params({
      buyerCountry: "CA",
      buyerPostalCode: "V6B 1A1",
      itemCategory: "service",
    }));
    expect(result.taxJurisdiction).toBe("CA-BC");
    expect(result.taxRateBasisPoints).toBe(1200); // full 5+7 for non-digital
  });

  it("applies AB GST-only 5% for services in Alberta", () => {
    const result = calculateTax(params({
      buyerCountry: "CA",
      buyerPostalCode: "T2P 1J9",
      itemCategory: "service",
    }));
    expect(result.taxRateBasisPoints).toBe(500);
  });
});


describe("validateTaxCalculationParams", () => {
  const validBody = {
    buyerCountry: "US",
    buyerPostalCode: "90210",
    merchantCountry: "US",
    merchantPostalCode: "10001",
    itemCategory: "physical_goods",
    amountStroops: "1000000",
  };

  it("accepts a valid body", () => {
    const result = validateTaxCalculationParams(validBody);
    expect(result.ok).toBe(true);
  });

  it("accepts optional buyerVatId", () => {
    const result = validateTaxCalculationParams({ ...validBody, buyerVatId: "DE123456789" });
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value.buyerVatId).toBe("DE123456789");
  });

  it("rejects missing buyerCountry", () => {
    const { buyerCountry: _, ...rest } = validBody;
    const result = validateTaxCalculationParams(rest);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.details?.field).toBe("buyerCountry");
  });

  it("rejects invalid country code (too long)", () => {
    const result = validateTaxCalculationParams({ ...validBody, buyerCountry: "USA" });
    expect(result.ok).toBe(false);
  });

  it("rejects invalid country code (numeric)", () => {
    const result = validateTaxCalculationParams({ ...validBody, buyerCountry: "12" });
    expect(result.ok).toBe(false);
  });

  it("rejects invalid itemCategory", () => {
    const result = validateTaxCalculationParams({ ...validBody, itemCategory: "luxury" });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.details?.field).toBe("itemCategory");
  });

  it("rejects fractional amountStroops", () => {
    const result = validateTaxCalculationParams({ ...validBody, amountStroops: "100.50" });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.details?.field).toBe("amountStroops");
  });

  it("rejects negative amountStroops", () => {
    const result = validateTaxCalculationParams({ ...validBody, amountStroops: "-1000" });
    expect(result.ok).toBe(false);
  });

  it("accepts amountStroops of '0'", () => {
    const result = validateTaxCalculationParams({ ...validBody, amountStroops: "0" });
    expect(result.ok).toBe(true);
  });

  it("rejects empty buyerVatId string", () => {
    const result = validateTaxCalculationParams({ ...validBody, buyerVatId: "  " });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.details?.field).toBe("buyerVatId");
  });

  it("normalises country codes to uppercase", () => {
    const result = validateTaxCalculationParams({ ...validBody, buyerCountry: "de" });
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value.buyerCountry).toBe("DE");
  });
});
