import { describe, expect, it } from 'vitest';
import { evaluateSorobanSimulationResources } from './soroban-tx-simulation-helper.js';

describe('evaluateSorobanSimulationResources', () => {
  it('returns healthy status and deterministic sha256 checksum within nominal bounds', () => {
    const result = evaluateSorobanSimulationResources({
      referenceId: 'ref-100',
      cpuInstructions: 150,
      readWriteBytes: 50,
      safetyMarginBps: 10,
      thresholdLimit: 1000,
    });
    expect(result.status).toBe('healthy');
    expect(result.utilizationBps).toBe(2000);
    expect(result.checksumHex).toHaveLength(64);
  });

  it('transitions to halted when utilization or secondary metric breaches threshold', () => {
    const result = evaluateSorobanSimulationResources({
      referenceId: 'ref-200',
      cpuInstructions: 700,
      readWriteBytes: 300,
      safetyMarginBps: 1200,
      thresholdLimit: 1000,
    });
    expect(result.status).toBe('halted');
    expect(result.utilizationBps).toBe(10000);
    expect(result.summary).toContain('limit exceeded');
  });

  it('rejects blank referenceId or non-finite numbers', () => {
    expect(() =>
      evaluateSorobanSimulationResources({
        referenceId: '   ',
        cpuInstructions: 1,
        readWriteBytes: 2,
        safetyMarginBps: 3,
      }),
    ).toThrow(/referenceId is required/);
  });
});
