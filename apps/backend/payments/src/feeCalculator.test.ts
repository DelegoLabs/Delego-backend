import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  calculatePayoutFees,
  DEFAULT_BASE_PLATFORM_FEE_PERCENT,
  DEFAULT_NETWORK_GAS_RESERVE_STROOPS,
  DEFAULT_VOLUME_TIERS,
} from "./feeCalculator.ts";

describe("feeCalculator - Issue #623", () => {
  it("guarantees netPayoutStroops + totalDeductions === grossAmountStroops invariant", () => {
    const testCases: bigint[] = [
      10_000_000n,            // 1 XLM
      123_456_789n,           // 12.3456789 XLM
      999_999_999_999n,       // large odd amount
      10_000_000_000n,        // 1,000 XLM
      77_777_777_777n,        // prime / repeating decimals
      100_000_000_000n,       // 10,000 XLM
    ];

    for (const gross of testCases) {
      const result = calculatePayoutFees({
        grossAmountStroops: gross,
        basePlatformFeePercent: 1.5,
        referralPercent: 0.5,
        networkGasReserveStroops: 100_000n,
      });

      const totalDeductions =
        result.platformFeeStroops +
        result.referralFeeStroops +
        result.networkGasReserveStroops;

      assert.strictEqual(result.netPayoutStroops + totalDeductions, result.grossAmountStroops);
      assert.ok(result.netPayoutStroops >= 0n);
    }
  });

  it("applies tiered volume fee discounts correctly", () => {
    const basePercent = 2.0;

    // No tier reached
    const resultTier0 = calculatePayoutFees({
      grossAmountStroops: 50_000_000_000n,
      basePlatformFeePercent: basePercent,
      monthlyVolumeStroops: 5_000_000_000n, // < 10,000,000,000
    });
    assert.strictEqual(resultTier0.platformFeePercent, 2.0);

    // Tier 1: 10% discount (2.0 * 0.9 = 1.8%)
    const resultTier1 = calculatePayoutFees({
      grossAmountStroops: 50_000_000_000n,
      basePlatformFeePercent: basePercent,
      monthlyVolumeStroops: 15_000_000_000n, // >= 10,000,000,000
    });
    assert.strictEqual(resultTier1.platformFeePercent, 1.8);

    // Tier 2: 20% discount (2.0 * 0.8 = 1.6%)
    const resultTier2 = calculatePayoutFees({
      grossAmountStroops: 50_000_000_000n,
      basePlatformFeePercent: basePercent,
      monthlyVolumeStroops: 60_000_000_000n, // >= 50,000,000,000
    });
    assert.strictEqual(resultTier2.platformFeePercent, 1.6);

    // Tier 3: 30% discount (2.0 * 0.7 = 1.4%)
    const resultTier3 = calculatePayoutFees({
      grossAmountStroops: 50_000_000_000n,
      basePlatformFeePercent: basePercent,
      monthlyVolumeStroops: 150_000_000_000n, // >= 100,000,000,000
    });
    assert.strictEqual(resultTier3.platformFeePercent, 1.4);
  });

  it("handles combination of flat and percentage referral fees", () => {
    const result = calculatePayoutFees({
      grossAmountStroops: 1_000_000_000n, // 100 XLM
      basePlatformFeePercent: 1.0,
      referralPercent: 0.5,
      flatReferralFeeStroops: 500_000n,
      networkGasReserveStroops: 100_000n,
    });

    // 0.5% of 1_000_000_000 is 5_000_000 + 500_000 flat = 5_500_000
    assert.strictEqual(result.referralFeeStroops, 5_500_000n);
    // 1% of 1_000_000_000 is 10_000_000
    assert.strictEqual(result.platformFeeStroops, 10_000_000n);
    assert.strictEqual(result.networkGasReserveStroops, 100_000n);
    assert.strictEqual(
      result.netPayoutStroops,
      1_000_000_000n - 10_000_000n - 5_500_000n - 100_000n
    );
  });

  it("throws error when deductions exceed gross amount", () => {
    assert.throws(
      () =>
        calculatePayoutFees({
          grossAmountStroops: 50_000n,
          networkGasReserveStroops: 100_000n,
        }),
      /exceed gross balance/
    );
  });

  it("throws error on negative gross amount", () => {
    assert.throws(
      () =>
        calculatePayoutFees({
          grossAmountStroops: -100n,
        }),
      /negative/
    );
  });
});
