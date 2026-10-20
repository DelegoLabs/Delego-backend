import { describe, expect, it } from 'vitest';
import { processDisputeRaisedOnChainEvent } from './dispute-raised-event-processor.js';

describe('processDisputeRaisedOnChainEvent', () => {
  it('returns healthy status and deterministic sha256 checksum within nominal bounds', () => {
    const result = processDisputeRaisedOnChainEvent({
      referenceId: 'ref-100',
      escrowAmountStroops: 150,
      evidenceCount: 50,
      arbiterAssignedFlag: 10,
      thresholdLimit: 1000,
    });
    expect(result.status).toBe('healthy');
    expect(result.utilizationBps).toBe(2000);
    expect(result.checksumHex).toHaveLength(64);
  });

  it('transitions to halted when utilization or secondary metric breaches threshold', () => {
    const result = processDisputeRaisedOnChainEvent({
      referenceId: 'ref-200',
      escrowAmountStroops: 700,
      evidenceCount: 300,
      arbiterAssignedFlag: 1200,
      thresholdLimit: 1000,
    });
    expect(result.status).toBe('halted');
    expect(result.utilizationBps).toBe(10000);
    expect(result.summary).toContain('limit exceeded');
  });

  it('rejects blank referenceId or non-finite numbers', () => {
    expect(() =>
      processDisputeRaisedOnChainEvent({
        referenceId: '   ',
        escrowAmountStroops: 1,
        evidenceCount: 2,
        arbiterAssignedFlag: 3,
      }),
    ).toThrow(/referenceId is required/);
  });
});
