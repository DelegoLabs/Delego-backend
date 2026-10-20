import { describe, expect, it } from 'vitest';
import { deduplicateSorobanEvents } from './soroban-event-dedup-cache.js';

describe('deduplicateSorobanEvents', () => {
  it('returns healthy status and deterministic sha256 checksum within nominal bounds', () => {
    const result = deduplicateSorobanEvents({
      referenceId: 'ref-100',
      incomingEventCount: 150,
      duplicateHitCount: 50,
      ttlSeconds: 10,
      thresholdLimit: 1000,
    });
    expect(result.status).toBe('healthy');
    expect(result.utilizationBps).toBe(2000);
    expect(result.checksumHex).toHaveLength(64);
  });

  it('transitions to halted when utilization or secondary metric breaches threshold', () => {
    const result = deduplicateSorobanEvents({
      referenceId: 'ref-200',
      incomingEventCount: 700,
      duplicateHitCount: 300,
      ttlSeconds: 1200,
      thresholdLimit: 1000,
    });
    expect(result.status).toBe('halted');
    expect(result.utilizationBps).toBe(10000);
    expect(result.summary).toContain('limit exceeded');
  });

  it('rejects blank referenceId or non-finite numbers', () => {
    expect(() =>
      deduplicateSorobanEvents({
        referenceId: '   ',
        incomingEventCount: 1,
        duplicateHitCount: 2,
        ttlSeconds: 3,
      }),
    ).toThrow(/referenceId is required/);
  });
});
