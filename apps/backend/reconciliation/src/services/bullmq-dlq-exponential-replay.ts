import { createHash } from 'node:crypto';

export interface DlqReplayScheduleInput {
  referenceId: string;
  attemptCount: number;
  baseBackoffMs: number;
  deadLetterDepth: number;
  thresholdLimit?: number;
}

export interface DlqReplaySchedule {
  referenceId: string;
  attemptCount: number;
  baseBackoffMs: number;
  deadLetterDepth: number;
  utilizationBps: number;
  status: 'healthy' | 'degraded' | 'halted';
  summary: string;
  checksumHex: string;
}

export function computeDlqExponentialReplayDelay(input: DlqReplayScheduleInput): DlqReplaySchedule {
  const referenceId = input.referenceId.trim();
  if (!referenceId) {
    throw new Error('computeDlqExponentialReplayDelay: referenceId is required');
  }
  if (
    !Number.isFinite(input.attemptCount) ||
    !Number.isFinite(input.baseBackoffMs) ||
    !Number.isFinite(input.deadLetterDepth)
  ) {
    throw new Error('computeDlqExponentialReplayDelay: numeric inputs must be finite');
  }

  const v1 = Math.max(0, Math.trunc(input.attemptCount));
  const v2 = Math.max(0, Math.trunc(input.baseBackoffMs));
  const v3 = Math.max(0, Math.trunc(input.deadLetterDepth));
  const limit = Math.max(1, Math.trunc(input.thresholdLimit ?? 1000));

  const utilizationBps = Math.min(10000, Math.round(((v1 + v2) * 10000) / limit));
  let status: 'healthy' | 'degraded' | 'halted' = 'healthy';
  let summary = `nominal (attemptCount=${v1}, baseBackoffMs=${v2}, deadLetterDepth=${v3})`;

  if (v3 > limit || utilizationBps >= 9000) {
    status = 'halted';
    summary = `limit exceeded: utilization=${utilizationBps}bps, deadLetterDepth=${v3} > ${limit}`;
  } else if (utilizationBps >= 5000) {
    status = 'degraded';
    summary = `elevated utilization=${utilizationBps}bps for ${referenceId}`;
  }

  const canonical = JSON.stringify({
    referenceId,
    attemptCount: v1,
    baseBackoffMs: v2,
    deadLetterDepth: v3,
    utilizationBps,
    status,
    summary,
  });
  const checksumHex = createHash('sha256').update(canonical).digest('hex');

  return {
    referenceId,
    attemptCount: v1,
    baseBackoffMs: v2,
    deadLetterDepth: v3,
    utilizationBps,
    status,
    summary,
    checksumHex,
  };
}
