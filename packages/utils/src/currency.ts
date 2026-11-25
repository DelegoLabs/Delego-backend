/** Stellar currency helpers — 1 XLM = 10_000_000 stroops */

const STROOPS_PER_XLM = 10_000_000n;

export function stroopsToDisplay(stroops: bigint, decimals = 7): string {
  const whole = stroops / STROOPS_PER_XLM;
  const fraction = stroops % STROOPS_PER_XLM;
  const fractionStr = fraction.toString().padStart(7, "0").slice(0, decimals);
  return `${whole}.${fractionStr}`;
}

export function displayToStroops(amount: string): bigint {
  const [whole = "0", fraction = ""] = amount.split(".");
  const paddedFraction = (fraction + "0000000").slice(0, 7);
  return BigInt(whole) * STROOPS_PER_XLM + BigInt(paddedFraction);
}

/**
 * Adds two non-negative decimal strings exactly (no floating point error).
 * Example: addDecimalStrings("0.1", "0.2") === "0.3"
 */
export function addDecimalStrings(a: string, b: string): string {
  const [aWhole = "0", aFrac = ""] = a.split(".");
  const [bWhole = "0", bFrac = ""] = b.split(".");
  const scale = Math.max(aFrac.length, bFrac.length);
  const aScaled =
    BigInt(aWhole || "0") * 10n ** BigInt(scale) +
    BigInt((aFrac + "0".repeat(scale)).slice(0, scale) || "0");
  const bScaled =
    BigInt(bWhole || "0") * 10n ** BigInt(scale) +
    BigInt((bFrac + "0".repeat(scale)).slice(0, scale) || "0");
  const sum = aScaled + bScaled;
  if (scale === 0) return sum.toString();
  const base = 10n ** BigInt(scale);
  const whole = sum / base;
  const frac = (sum % base).toString().padStart(scale, "0");
  return `${whole}.${frac}`;
}

/**
 * Sums an array of decimal strings exactly.
 */
export function sumDecimalStrings(values: readonly string[]): string {
  return values.reduce((acc, v) => addDecimalStrings(acc, v), "0");
}
