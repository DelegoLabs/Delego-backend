import { createHash } from 'node:crypto';

export interface UpgradeGovernanceAlertInput {
  referenceId: string;
  timelockElapsedSecs: number;
  guardianApprovals: number;
  requiredApprovals: number;
  thresholdLimit?: number;
}

export interface UpgradeGovernanceAlert {
  referenceId: string;
  timelockElapsedSecs: number;
  guardianApprovals: number;
  requiredApprovals: number;
  utilizationBps: number;
  status: 'healthy' | 'degraded' | 'halted';
  summary: string;
  checksumHex: string;
}

export function verifyContractUpgradeEvent(input: UpgradeGovernanceAlertInput): UpgradeGovernanceAlert {
  const referenceId = input.referenceId.trim();
  if (!referenceId) {
    throw new Error('verifyContractUpgradeEvent: referenceId is required');
  }
  if (
    !Number.isFinite(input.timelockElapsedSecs) ||
    !Number.isFinite(input.guardianApprovals) ||
    !Number.isFinite(input.requiredApprovals)
  ) {
    throw new Error('verifyContractUpgradeEvent: numeric inputs must be finite');
  }

  const v1 = Math.max(0, Math.trunc(input.timelockElapsedSecs));
  const v2 = Math.max(0, Math.trunc(input.guardianApprovals));
  const v3 = Math.max(0, Math.trunc(input.requiredApprovals));
  const limit = Math.max(1, Math.trunc(input.thresholdLimit ?? 1000));

  const utilizationBps = Math.min(10000, Math.round(((v1 + v2) * 10000) / limit));
  let status: 'healthy' | 'degraded' | 'halted' = 'healthy';
  let summary = `nominal (timelockElapsedSecs=${v1}, guardianApprovals=${v2}, requiredApprovals=${v3})`;

  if (v3 > limit || utilizationBps >= 9000) {
    status = 'halted';
    summary = `limit exceeded: utilization=${utilizationBps}bps, requiredApprovals=${v3} > ${limit}`;
  } else if (utilizationBps >= 5000) {
    status = 'degraded';
    summary = `elevated utilization=${utilizationBps}bps for ${referenceId}`;
  }

  const canonical = JSON.stringify({
    referenceId,
    timelockElapsedSecs: v1,
    guardianApprovals: v2,
    requiredApprovals: v3,
    utilizationBps,
    status,
    summary,
  });
  const checksumHex = createHash('sha256').update(canonical).digest('hex');

  return {
    referenceId,
    timelockElapsedSecs: v1,
    guardianApprovals: v2,
    requiredApprovals: v3,
    utilizationBps,
    status,
    summary,
    checksumHex,
  };
}
