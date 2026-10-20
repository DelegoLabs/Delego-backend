import { describe, expect, it } from 'vitest';
import { predictStellarFeePoolGasPrice } from './stellar-gas-price-prediction.js';

describe('predictStellarFeePoolGasPrice', () => {
  it('returns healthy status and deterministic sha256 checksum within nominal bounds', () => {
    const result = predictStellarFeePoolGasPrice({
      referenceId: 'ref-100',
      p50FeeStroops: 150,
      p95FeeStroops: 50,
      ledgerSurgeUtilizationBps: 10,
      thresholdLimit: 1000,
    });
    expect(result.status).toBe('healthy');
    expect(result.utilizationBps).toBe(2000);
    expect(result.checksumHex).toHaveLength(64);
  });

  it('transitions to halted when utilization or secondary metric breaches threshold', () => {
    const result = predictStellarFeePoolGasPrice({
      referenceId: 'ref-200',
      p50FeeStroops: 700,
      p95FeeStroops: 300,
      ledgerSurgeUtilizationBps: 1200,
      thresholdLimit: 1000,
    });
    expect(result.status).toBe('halted');
    expect(result.utilizationBps).toBe(10000);
    expect(result.summary).toContain('limit exceeded');
  });

  it('rejects blank referenceId or non-finite numbers', () => {
    expect(() =>
      predictStellarFeePoolGasPrice({
        referenceId: '   ',
        p50FeeStroops: 1,
        p95FeeStroops: 2,
        ledgerSurgeUtilizationBps: 3,
      }),
    ).toThrow(/referenceId is required/);
  });
});
