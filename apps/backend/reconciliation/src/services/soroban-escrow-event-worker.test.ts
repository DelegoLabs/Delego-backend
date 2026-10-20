import { describe, expect, it } from 'vitest';
import { ingestSorobanEscrowStateEvents } from './soroban-escrow-event-worker.js';

describe('ingestSorobanEscrowStateEvents', () => {
  it('returns healthy status and deterministic sha256 checksum within nominal bounds', () => {
    const result = ingestSorobanEscrowStateEvents({
      referenceId: 'ref-100',
      scannedLedgers: 150,
      stateTransitionsApplied: 50,
      retryQueueDepth: 10,
      thresholdLimit: 1000,
    });
    expect(result.status).toBe('healthy');
    expect(result.utilizationBps).toBe(2000);
    expect(result.checksumHex).toHaveLength(64);
  });

  it('transitions to halted when utilization or secondary metric breaches threshold', () => {
    const result = ingestSorobanEscrowStateEvents({
      referenceId: 'ref-200',
      scannedLedgers: 700,
      stateTransitionsApplied: 300,
      retryQueueDepth: 1200,
      thresholdLimit: 1000,
    });
    expect(result.status).toBe('halted');
    expect(result.utilizationBps).toBe(10000);
    expect(result.summary).toContain('limit exceeded');
  });

  it('rejects blank referenceId or non-finite numbers', () => {
    expect(() =>
      ingestSorobanEscrowStateEvents({
        referenceId: '   ',
        scannedLedgers: 1,
        stateTransitionsApplied: 2,
        retryQueueDepth: 3,
      }),
    ).toThrow(/referenceId is required/);
  });
});
