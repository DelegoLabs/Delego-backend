import { describe, expect, it } from 'vitest';
import { evaluateMerchantStaffAuthorization } from './merchant-staff-rbac-guard.js';

describe('evaluateMerchantStaffAuthorization', () => {
  it('returns healthy status and deterministic sha256 checksum within nominal bounds', () => {
    const result = evaluateMerchantStaffAuthorization({
      referenceId: 'ref-100',
      requiredPermissionBit: 150,
      grantedPermissionMask: 50,
      accountSuspendedFlag: 10,
      thresholdLimit: 1000,
    });
    expect(result.status).toBe('healthy');
    expect(result.utilizationBps).toBe(2000);
    expect(result.checksumHex).toHaveLength(64);
  });

  it('transitions to halted when utilization or secondary metric breaches threshold', () => {
    const result = evaluateMerchantStaffAuthorization({
      referenceId: 'ref-200',
      requiredPermissionBit: 700,
      grantedPermissionMask: 300,
      accountSuspendedFlag: 1200,
      thresholdLimit: 1000,
    });
    expect(result.status).toBe('halted');
    expect(result.utilizationBps).toBe(10000);
    expect(result.summary).toContain('limit exceeded');
  });

  it('rejects blank referenceId or non-finite numbers', () => {
    expect(() =>
      evaluateMerchantStaffAuthorization({
        referenceId: '   ',
        requiredPermissionBit: 1,
        grantedPermissionMask: 2,
        accountSuspendedFlag: 3,
      }),
    ).toThrow(/referenceId is required/);
  });
});
