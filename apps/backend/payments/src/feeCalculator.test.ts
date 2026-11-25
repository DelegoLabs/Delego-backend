import { describe, expect, it } from "vitest";
import {
  DEFAULT_PAYOUT_FEE_CONFIG,
  PayoutFeeError,
  calculatePayoutFees,
  selectFeeTier,
  totalDeductionsStroops,
  type PayoutFeeConfig,
} from "./feeCalculator.js";

const XLM = 10_000_000n;
const noGas: PayoutFeeConfig = { ...DEFAULT_PAYOUT_FEE_CONFIG, networkGasReserveStroops: 0n };

describe("calculatePayoutFees", () => {
  it("computes the base 1.5% fee, referral cut and gas reserve", () => {
    const gross = 1_000n * XLM;
    const calc = calculatePayoutFees({ grossAmountStroops: gross, referralFeeBps: 50 });
    expect(calc.platformFeePercent).toBe(1.5);
    expect(calc.platformFeeStroops).toBe(150_000_000n);
    expect(calc.referralFeeStroops).toBe(50_000_000n);
    expect(calc.networkGasReserveStroops).toBe(100_000n);
    expect(calc.netPayoutStroops).toBe(gross - 150_000_000n - 50_000_000n - 100_000n);
  });

  it("rounds every deduction down, favoring the merchant", () => {
    const calc = calculatePayoutFees({ grossAmountStroops: 999_999n, referralFeeBps: 33 }, noGas);
    // 999_999 * 150 / 10_000 = 14_999.985 -> 14_999 ; * 33 / 10_000 = 3_299.9967 -> 3_299
    expect(calc.platformFeeStroops).toBe(14_999n);
    expect(calc.referralFeeStroops).toBe(3_299n);
  });

  it("guarantees net + deductions === gross across many amounts and rates", () => {
    const grosses = [1_000_000n, 1_000_001n, 7n * XLM + 3n, 123_456_789_012_345n, 2n ** 62n + 12345n];
    for (const gross of grosses) {
      for (const volume of [0n, 100_000n * XLM, 600_000n * XLM, 5_000_000n * XLM]) {
        for (const referralFeeBps of [0, 1, 37, 250, 1000]) {
          const calc = calculatePayoutFees({ grossAmountStroops: gross, merchantVolumeStroops: volume, referralFeeBps });
          expect(calc.netPayoutStroops + totalDeductionsStroops(calc)).toBe(gross);
          expect(calc.netPayoutStroops).toBeGreaterThan(0n);
        }
      }
    }
  });

  it("stays exact beyond Number.MAX_SAFE_INTEGER", () => {
    const gross = 9_007_199_254_740_993_000n;
    const calc = calculatePayoutFees({ grossAmountStroops: gross }, noGas);
    expect(calc.platformFeeStroops).toBe((gross * 150n) / 10_000n);
    expect(calc.netPayoutStroops + calc.platformFeeStroops).toBe(gross);
  });

  describe("tiered volume discounts", () => {
    it.each([
      [0n, 1.5],
      [99_999n * XLM, 1.5],
      [100_000n * XLM, 1.25],
      [499_999n * XLM, 1.25],
      [500_000n * XLM, 1],
      [1_000_000n * XLM, 0.75],
      [50_000_000n * XLM, 0.75],
    ])("volume %s stroops pays %s%%", (volume, percent) => {
      const calc = calculatePayoutFees({ grossAmountStroops: 1_000n * XLM, merchantVolumeStroops: volume });
      expect(calc.platformFeePercent).toBe(percent);
    });

    it("selects correctly regardless of tier ordering", () => {
      const shuffled = [...DEFAULT_PAYOUT_FEE_CONFIG.tiers].reverse();
      expect(selectFeeTier(shuffled, 600_000n * XLM).platformFeeBps).toBe(100);
    });

    it("applies a lower fee to the same gross for a higher-volume merchant", () => {
      const base = calculatePayoutFees({ grossAmountStroops: 1_000n * XLM });
      const vip = calculatePayoutFees({ grossAmountStroops: 1_000n * XLM, merchantVolumeStroops: 2_000_000n * XLM });
      expect(vip.platformFeeStroops).toBeLessThan(base.platformFeeStroops);
      expect(vip.netPayoutStroops).toBeGreaterThan(base.netPayoutStroops);
    });

    it("rejects a schedule with no zero-volume tier", () => {
      expect(() => selectFeeTier([{ minVolumeStroops: 10n, platformFeeBps: 100 }], 0n)).toThrow(PayoutFeeError);
    });
  });

  describe("validation", () => {
    it("rejects non-positive gross", () => {
      expect(() => calculatePayoutFees({ grossAmountStroops: 0n })).toThrow(PayoutFeeError);
      expect(() => calculatePayoutFees({ grossAmountStroops: -5n })).toThrow(PayoutFeeError);
    });

    it("rejects fractional or out-of-range basis points", () => {
      expect(() => calculatePayoutFees({ grossAmountStroops: XLM, referralFeeBps: 1.5 })).toThrow(PayoutFeeError);
      expect(() => calculatePayoutFees({ grossAmountStroops: XLM, referralFeeBps: -1 })).toThrow(PayoutFeeError);
      expect(() => calculatePayoutFees({ grossAmountStroops: XLM, referralFeeBps: 10_001 })).toThrow(PayoutFeeError);
    });

    it("rejects payouts whose deductions consume the whole balance", () => {
      expect(() => calculatePayoutFees({ grossAmountStroops: 100_000n })).toThrow(/not viable/);
    });
  });
});
