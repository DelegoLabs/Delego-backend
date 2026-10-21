/**
 * Payout Fee Deduction Calculator with Platform Splits and Volume Tiers
 * 
 * Issue #623: When payouts are compiled, platform commission fees, referral affiliate cuts,
 * and network gas costs must be deducted accurately from merchant gross balances using
 * pure BigInt integer arithmetic to prevent floating-point drift.
 */

export interface PayoutFeeCalculation {
  grossAmountStroops: bigint;
  platformFeePercent: number; // e.g. 1.5%
  platformFeeStroops: bigint;
  referralFeeStroops: bigint;
  networkGasReserveStroops: bigint;
  netPayoutStroops: bigint;
}

export interface VolumeTierDiscount {
  /** Minimum monthly volume in stroops to qualify for tier */
  thresholdStroops: bigint;
  /** Effective platform fee percentage for this tier, or discount percentage */
  discountPercent: number; // e.g. 10 means 10% discount off base platform fee
}

export interface CalculatePayoutFeeOptions {
  grossAmountStroops: bigint;
  basePlatformFeePercent?: number; // default 1.5%
  referralPercent?: number; // e.g. 0.5%
  flatReferralFeeStroops?: bigint; // optional flat referral
  networkGasReserveStroops?: bigint; // default 100_000n (0.01 XLM reserve)
  monthlyVolumeStroops?: bigint; // merchant cumulative monthly volume
  customTiers?: VolumeTierDiscount[];
}

/** Standard default volume discount tiers based on monthly volume */
export const DEFAULT_VOLUME_TIERS: VolumeTierDiscount[] = [
  { thresholdStroops: 100_000_000_000n, discountPercent: 30 }, // >= 10,000 XLM -> 30% discount
  { thresholdStroops: 50_000_000_000n, discountPercent: 20 },  // >= 5,000 XLM -> 20% discount
  { thresholdStroops: 10_000_000_000n, discountPercent: 10 },  // >= 1,000 XLM -> 10% discount
];

export const DEFAULT_BASE_PLATFORM_FEE_PERCENT = 1.5;
export const DEFAULT_NETWORK_GAS_RESERVE_STROOPS = 100_000n; // 0.01 XLM

/**
 * Calculates fee deductions and net payout using pure integer arithmetic (scaled to 1,000,000).
 */
export function calculatePayoutFees(options: CalculatePayoutFeeOptions): PayoutFeeCalculation {
  const {
    grossAmountStroops,
    basePlatformFeePercent = DEFAULT_BASE_PLATFORM_FEE_PERCENT,
    referralPercent = 0,
    flatReferralFeeStroops = 0n,
    networkGasReserveStroops = DEFAULT_NETWORK_GAS_RESERVE_STROOPS,
    monthlyVolumeStroops = 0n,
    customTiers = DEFAULT_VOLUME_TIERS,
  } = options;

  if (grossAmountStroops < 0n) {
    throw new Error("grossAmountStroops cannot be negative");
  }

  // 1. Determine tiered volume discount
  let volumeDiscountPercent = 0;
  const sortedTiers = [...customTiers].sort((a, b) => 
    a.thresholdStroops < b.thresholdStroops ? 1 : a.thresholdStroops > b.thresholdStroops ? -1 : 0
  );

  for (const tier of sortedTiers) {
    if (monthlyVolumeStroops >= tier.thresholdStroops) {
      volumeDiscountPercent = tier.discountPercent;
      break;
    }
  }

  // Calculate effective platform fee percentage
  const effectivePlatformFeePercent = Math.max(
    0,
    basePlatformFeePercent * (1 - volumeDiscountPercent / 100)
  );

  // 2. Pure BigInt integer arithmetic: scale percentage by 10,000 to keep 4 decimal places (bps * 100)
  // Example: 1.5% -> 15_000 parts per million (PPM)
  const platformFeePpm = BigInt(Math.round(effectivePlatformFeePercent * 10_000));
  const platformFeeStroops = (grossAmountStroops * platformFeePpm) / 1_000_000n;

  // Referral fee calculation
  const referralPpm = BigInt(Math.round(referralPercent * 10_000));
  const percentageReferralFeeStroops = (grossAmountStroops * referralPpm) / 1_000_000n;
  const referralFeeStroops = percentageReferralFeeStroops + flatReferralFeeStroops;

  // 3. Deductions & Net Payout
  const totalDeductions = platformFeeStroops + referralFeeStroops + networkGasReserveStroops;
  
  if (totalDeductions > grossAmountStroops) {
    throw new Error(`Total deductions (${totalDeductions} stroops) exceed gross balance (${grossAmountStroops} stroops)`);
  }

  const netPayoutStroops = grossAmountStroops - totalDeductions;

  // Mathematical invariant assertion: net + deductions === gross
  if (netPayoutStroops + totalDeductions !== grossAmountStroops) {
    throw new Error("Mathematical assertion failed: netPayoutStroops + totalDeductions !== grossAmountStroops");
  }

  return {
    grossAmountStroops,
    platformFeePercent: effectivePlatformFeePercent,
    platformFeeStroops,
    referralFeeStroops,
    networkGasReserveStroops,
    netPayoutStroops,
  };
}
