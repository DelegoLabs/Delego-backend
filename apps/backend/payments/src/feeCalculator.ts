/**
 * Merchant payout fee deduction calculator (Issue #623).
 *
 * Deducts the platform commission, referral affiliate cut and network gas
 * reserve from a merchant's gross balance using BigInt integer arithmetic
 * only. Rates are carried internally as integer basis points (1 bp = 0.01%)
 * so no floating point value ever touches an amount; every deduction rounds
 * DOWN (favoring the merchant) and the net payout is derived by subtraction,
 * so `net + total deductions === gross` holds by construction and is
 * re-asserted before returning.
 */

const BPS_DENOMINATOR = 10_000n;

export interface PayoutFeeCalculation {
  grossAmountStroops: bigint;
  platformFeePercent: number; // e.g. 1.5%
  platformFeeStroops: bigint;
  referralFeeStroops: bigint;
  networkGasReserveStroops: bigint;
  netPayoutStroops: bigint;
}

/** One volume tier: merchants at or above `minVolumeStroops` pay `platformFeeBps`. */
export interface FeeTier {
  minVolumeStroops: bigint;
  platformFeeBps: number;
}

export interface PayoutFeeConfig {
  /** Tiers by trailing volume; need not be sorted. Must include a tier with minVolumeStroops 0. */
  tiers: FeeTier[];
  /** Flat reserve held back to cover network gas for the payout transaction. */
  networkGasReserveStroops: bigint;
}

export interface PayoutFeeInput {
  grossAmountStroops: bigint;
  /** Merchant's trailing volume used to select the fee tier. Defaults to 0 (base tier). */
  merchantVolumeStroops?: bigint;
  /** Referral affiliate cut in basis points of gross; omit/0 when the merchant was not referred. */
  referralFeeBps?: number;
}

const XLM = 10_000_000n;

/** Default schedule: 1.5% base, discounted at higher trailing volume. */
export const DEFAULT_PAYOUT_FEE_CONFIG: PayoutFeeConfig = {
  tiers: [
    { minVolumeStroops: 0n, platformFeeBps: 150 },
    { minVolumeStroops: 100_000n * XLM, platformFeeBps: 125 },
    { minVolumeStroops: 500_000n * XLM, platformFeeBps: 100 },
    { minVolumeStroops: 1_000_000n * XLM, platformFeeBps: 75 },
  ],
  networkGasReserveStroops: 100_000n,
};

export class PayoutFeeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PayoutFeeError";
  }
}

function assertBps(value: number, label: string): void {
  if (!Number.isInteger(value) || value < 0 || value > Number(BPS_DENOMINATOR)) {
    throw new PayoutFeeError(`${label} must be an integer between 0 and ${BPS_DENOMINATOR} basis points`);
  }
}

/** Pick the tier with the highest `minVolumeStroops` that the volume still satisfies. */
export function selectFeeTier(tiers: FeeTier[], volumeStroops: bigint): FeeTier {
  let selected: FeeTier | undefined;
  for (const tier of tiers) {
    assertBps(tier.platformFeeBps, "platformFeeBps");
    if (tier.minVolumeStroops < 0n) throw new PayoutFeeError("tier minVolumeStroops must not be negative");
    if (tier.minVolumeStroops <= volumeStroops && (!selected || tier.minVolumeStroops > selected.minVolumeStroops)) {
      selected = tier;
    }
  }
  if (!selected) throw new PayoutFeeError("fee tiers must include a tier with minVolumeStroops of 0");
  return selected;
}

/** floor(amount * bps / 10_000) — exact in BigInt, rounds toward the merchant. */
export function applyBps(amountStroops: bigint, bps: number): bigint {
  return (amountStroops * BigInt(bps)) / BPS_DENOMINATOR;
}

export function calculatePayoutFees(
  input: PayoutFeeInput,
  config: PayoutFeeConfig = DEFAULT_PAYOUT_FEE_CONFIG
): PayoutFeeCalculation {
  const gross = input.grossAmountStroops;
  if (typeof gross !== "bigint" || gross <= 0n) {
    throw new PayoutFeeError("grossAmountStroops must be a positive bigint");
  }
  if (config.networkGasReserveStroops < 0n) {
    throw new PayoutFeeError("networkGasReserveStroops must not be negative");
  }

  const referralBps = input.referralFeeBps ?? 0;
  assertBps(referralBps, "referralFeeBps");

  const tier = selectFeeTier(config.tiers, input.merchantVolumeStroops ?? 0n);

  const platformFeeStroops = applyBps(gross, tier.platformFeeBps);
  const referralFeeStroops = applyBps(gross, referralBps);
  const networkGasReserveStroops = config.networkGasReserveStroops;

  const totalDeductions = platformFeeStroops + referralFeeStroops + networkGasReserveStroops;
  if (totalDeductions >= gross) {
    throw new PayoutFeeError(
      `deductions (${totalDeductions}) would consume the entire gross amount (${gross}); payout is not viable`
    );
  }

  const netPayoutStroops = gross - totalDeductions;

  // Mathematical guarantee, asserted rather than assumed.
  if (netPayoutStroops + totalDeductions !== gross) {
    throw new PayoutFeeError("fee invariant violated: net payout + deductions !== gross");
  }

  return {
    grossAmountStroops: gross,
    platformFeePercent: tier.platformFeeBps / 100,
    platformFeeStroops,
    referralFeeStroops,
    networkGasReserveStroops,
    netPayoutStroops,
  };
}

/** Sum of every deduction in a calculation. */
export function totalDeductionsStroops(calc: PayoutFeeCalculation): bigint {
  return calc.platformFeeStroops + calc.referralFeeStroops + calc.networkGasReserveStroops;
}
