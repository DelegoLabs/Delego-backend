/**
 * VAT identification number format validation — Issue #505
 *
 * Each EU member state and the UK has a distinct format for VAT numbers.
 * We validate the format (regex) only — we do NOT call VIES or any
 * external service. A well-formed number satisfies the acceptance criterion
 * "verifies tax ID format before applying 0% rate".
 *
 * Formats sourced from the European Commission VIES FAQ and HMRC guidance.
 */

/** Map of ISO country code → VAT number regex (after stripping the 2-letter prefix). */
const VAT_PATTERNS: Record<string, RegExp> = {
  // EU member states
  AT: /^U\d{8}$/,              // ATU12345678
  BE: /^\d{10}$/,              // BE0123456789
  BG: /^\d{9,10}$/,            // BG123456789
  HR: /^\d{11}$/,              // HR12345678901
  CY: /^\d{8}[A-Z]$/,          // CY12345678X
  CZ: /^\d{8,10}$/,            // CZ12345678
  DK: /^\d{8}$/,               // DK12345678
  EE: /^\d{9}$/,               // EE123456789
  FI: /^\d{8}$/,               // FI12345678
  FR: /^[0-9A-Z]{2}\d{9}$/,    // FRXX123456789
  DE: /^\d{9}$/,               // DE123456789
  GR: /^\d{9}$/,               // EL123456789
  HU: /^\d{8}$/,               // HU12345678
  IE: /^\d{7}[A-Z]{1,2}$|^\d[A-Z+*]\d{5}[A-Z]$/, // IE1234567X
  IT: /^\d{11}$/,              // IT12345678901
  LV: /^\d{11}$/,              // LV12345678901
  LT: /^\d{9}$|\d{12}$/,       // LT123456789
  LU: /^\d{8}$/,               // LU12345678
  MT: /^\d{8}$/,               // MT12345678
  NL: /^\d{9}B\d{2}$/,         // NL123456789B01
  PL: /^\d{10}$/,              // PL1234567890
  PT: /^\d{9}$/,               // PT123456789
  RO: /^\d{2,10}$/,            // RO12
  SK: /^\d{10}$/,              // SK1234567890
  SI: /^\d{8}$/,               // SI12345678
  ES: /^[A-Z0-9]\d{7}[A-Z0-9]$/, // ESX1234567X
  SE: /^\d{12}$/,              // SE123456789012
  // Greece uses prefix "EL" not "GR" in VAT numbers
  EL: /^\d{9}$/,
  // UK post-Brexit
  GB: /^\d{9}$|\d{12}$|^GD\d{3}$|^HA\d{3}$/,
};

/**
 * Strips the leading 2-letter country prefix from a VAT number if present,
 * normalises whitespace and hyphens, and upper-cases the result.
 */
function normaliseVatId(raw: string): { prefix: string; body: string } {
  const cleaned = raw.replace(/[\s\-]/g, "").toUpperCase();
  // VAT numbers often start with the ISO country code (2 alpha chars)
  const prefixMatch = cleaned.match(/^([A-Z]{2})(.+)$/);
  if (prefixMatch) {
    return { prefix: prefixMatch[1]!, body: prefixMatch[2]! };
  }
  return { prefix: "", body: cleaned };
}

/**
 * Validates the format of a VAT identification number for a given country.
 *
 * @param vatId   The raw VAT number string (may include country prefix).
 * @param country The ISO 3166-1 alpha-2 country code of the registrant.
 * @returns `true` if the format is valid, `false` otherwise.
 */
export function isValidVatId(vatId: string, country: string): boolean {
  if (!vatId || !country) return false;

  const countryCode = country.toUpperCase();
  const { prefix, body } = normaliseVatId(vatId);

  // Greece's VAT prefix is "EL" but its ISO code is "GR"
  const effectivePrefix = prefix === "EL" ? "EL" : prefix;
  const lookupKey = effectivePrefix || countryCode;

  // If the embedded prefix contradicts the declared country, reject.
  if (prefix && prefix !== countryCode && !(countryCode === "GR" && prefix === "EL")) {
    return false;
  }

  const pattern = VAT_PATTERNS[lookupKey];
  if (!pattern) return false;

  return pattern.test(body);
}
