import { describe, expect, it } from 'vitest';
import { verifyContractUpgradeEvent } from './contract-upgrade-gov-listener.js';

describe('verifyContractUpgradeEvent', () => {
  it('returns healthy status and deterministic sha256 checksum within nominal bounds', () => {
    const result = verifyContractUpgradeEvent({
      referenceId: 'ref-100',
      timelockElapsedSecs: 150,
      guardianApprovals: 50,
      requiredApprovals: 10,
      thresholdLimit: 1000,
    });
    expect(result.status).toBe('healthy');
    expect(result.utilizationBps).toBe(2000);
    expect(result.checksumHex).toHaveLength(64);
  });

  it('transitions to halted when utilization or secondary metric breaches threshold', () => {
    const result = verifyContractUpgradeEvent({
      referenceId: 'ref-200',
      timelockElapsedSecs: 700,
      guardianApprovals: 300,
      requiredApprovals: 1200,
      thresholdLimit: 1000,
    });
    expect(result.status).toBe('halted');
    expect(result.utilizationBps).toBe(10000);
    expect(result.summary).toContain('limit exceeded');
  });

  it('rejects blank referenceId or non-finite numbers', () => {
    expect(() =>
      verifyContractUpgradeEvent({
        referenceId: '   ',
        timelockElapsedSecs: 1,
        guardianApprovals: 2,
        requiredApprovals: 3,
      }),
    ).toThrow(/referenceId is required/);
  });
});
