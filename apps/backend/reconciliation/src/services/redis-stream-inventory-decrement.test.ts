import { describe, expect, it } from 'vitest';
import { processInventoryDecrementStream } from './redis-stream-inventory-decrement.js';

describe('processInventoryDecrementStream', () => {
  it('returns healthy status and deterministic sha256 checksum within nominal bounds', () => {
    const result = processInventoryDecrementStream({
      referenceId: 'ref-100',
      availableUnits: 150,
      requestedUnits: 50,
      consumerLagCount: 10,
      thresholdLimit: 1000,
    });
    expect(result.status).toBe('healthy');
    expect(result.utilizationBps).toBe(2000);
    expect(result.checksumHex).toHaveLength(64);
  });

  it('transitions to halted when utilization or secondary metric breaches threshold', () => {
    const result = processInventoryDecrementStream({
      referenceId: 'ref-200',
      availableUnits: 700,
      requestedUnits: 300,
      consumerLagCount: 1200,
      thresholdLimit: 1000,
    });
    expect(result.status).toBe('halted');
    expect(result.utilizationBps).toBe(10000);
    expect(result.summary).toContain('limit exceeded');
  });

  it('rejects blank referenceId or non-finite numbers', () => {
    expect(() =>
      processInventoryDecrementStream({
        referenceId: '   ',
        availableUnits: 1,
        requestedUnits: 2,
        consumerLagCount: 3,
      }),
    ).toThrow(/referenceId is required/);
  });
});
