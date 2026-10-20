import { createHash } from 'node:crypto';

export interface SessionRevocationSummaryInput {
  referenceId: string;
  activeSessionCount: number;
  refreshTokenCount: number;
  revocationLatencyMs: number;
  thresholdLimit?: number;
}

export interface SessionRevocationSummary {
  referenceId: string;
  activeSessionCount: number;
  refreshTokenCount: number;
  revocationLatencyMs: number;
  utilizationBps: number;
  status: 'healthy' | 'degraded' | 'halted';
  summary: string;
  checksumHex: string;
}

export function purgeAllUserRedisSessions(input: SessionRevocationSummaryInput): SessionRevocationSummary {
  const referenceId = input.referenceId.trim();
  if (!referenceId) {
    throw new Error('purgeAllUserRedisSessions: referenceId is required');
  }
  if (
    !Number.isFinite(input.activeSessionCount) ||
    !Number.isFinite(input.refreshTokenCount) ||
    !Number.isFinite(input.revocationLatencyMs)
  ) {
    throw new Error('purgeAllUserRedisSessions: numeric inputs must be finite');
  }

  const v1 = Math.max(0, Math.trunc(input.activeSessionCount));
  const v2 = Math.max(0, Math.trunc(input.refreshTokenCount));
  const v3 = Math.max(0, Math.trunc(input.revocationLatencyMs));
  const limit = Math.max(1, Math.trunc(input.thresholdLimit ?? 1000));

  const utilizationBps = Math.min(10000, Math.round(((v1 + v2) * 10000) / limit));
  let status: 'healthy' | 'degraded' | 'halted' = 'healthy';
  let summary = `nominal (activeSessionCount=${v1}, refreshTokenCount=${v2}, revocationLatencyMs=${v3})`;

  if (v3 > limit || utilizationBps >= 9000) {
    status = 'halted';
    summary = `limit exceeded: utilization=${utilizationBps}bps, revocationLatencyMs=${v3} > ${limit}`;
  } else if (utilizationBps >= 5000) {
    status = 'degraded';
    summary = `elevated utilization=${utilizationBps}bps for ${referenceId}`;
  }

  const canonical = JSON.stringify({
    referenceId,
    activeSessionCount: v1,
    refreshTokenCount: v2,
    revocationLatencyMs: v3,
    utilizationBps,
    status,
    summary,
  });
  const checksumHex = createHash('sha256').update(canonical).digest('hex');

  return {
    referenceId,
    activeSessionCount: v1,
    refreshTokenCount: v2,
    revocationLatencyMs: v3,
    utilizationBps,
    status,
    summary,
    checksumHex,
  };
}
