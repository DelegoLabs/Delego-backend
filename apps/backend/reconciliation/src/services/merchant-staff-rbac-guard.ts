import { createHash } from 'node:crypto';

export interface StaffRbacDecisionInput {
  referenceId: string;
  requiredPermissionBit: number;
  grantedPermissionMask: number;
  accountSuspendedFlag: number;
  thresholdLimit?: number;
}

export interface StaffRbacDecision {
  referenceId: string;
  requiredPermissionBit: number;
  grantedPermissionMask: number;
  accountSuspendedFlag: number;
  utilizationBps: number;
  status: 'healthy' | 'degraded' | 'halted';
  summary: string;
  checksumHex: string;
}

export function evaluateMerchantStaffAuthorization(input: StaffRbacDecisionInput): StaffRbacDecision {
  const referenceId = input.referenceId.trim();
  if (!referenceId) {
    throw new Error('evaluateMerchantStaffAuthorization: referenceId is required');
  }
  if (
    !Number.isFinite(input.requiredPermissionBit) ||
    !Number.isFinite(input.grantedPermissionMask) ||
    !Number.isFinite(input.accountSuspendedFlag)
  ) {
    throw new Error('evaluateMerchantStaffAuthorization: numeric inputs must be finite');
  }

  const v1 = Math.max(0, Math.trunc(input.requiredPermissionBit));
  const v2 = Math.max(0, Math.trunc(input.grantedPermissionMask));
  const v3 = Math.max(0, Math.trunc(input.accountSuspendedFlag));
  const limit = Math.max(1, Math.trunc(input.thresholdLimit ?? 1000));

  const utilizationBps = Math.min(10000, Math.round(((v1 + v2) * 10000) / limit));
  let status: 'healthy' | 'degraded' | 'halted' = 'healthy';
  let summary = `nominal (requiredPermissionBit=${v1}, grantedPermissionMask=${v2}, accountSuspendedFlag=${v3})`;

  if (v3 > limit || utilizationBps >= 9000) {
    status = 'halted';
    summary = `limit exceeded: utilization=${utilizationBps}bps, accountSuspendedFlag=${v3} > ${limit}`;
  } else if (utilizationBps >= 5000) {
    status = 'degraded';
    summary = `elevated utilization=${utilizationBps}bps for ${referenceId}`;
  }

  const canonical = JSON.stringify({
    referenceId,
    requiredPermissionBit: v1,
    grantedPermissionMask: v2,
    accountSuspendedFlag: v3,
    utilizationBps,
    status,
    summary,
  });
  const checksumHex = createHash('sha256').update(canonical).digest('hex');

  return {
    referenceId,
    requiredPermissionBit: v1,
    grantedPermissionMask: v2,
    accountSuspendedFlag: v3,
    utilizationBps,
    status,
    summary,
    checksumHex,
  };
}
