import { createHash } from 'node:crypto';

export interface SmsQueueDispatchReportInput {
  referenceId: string;
  queuedMessages: number;
  providerQuotaPerMin: number;
  dlqRetryCount: number;
  thresholdLimit?: number;
}

export interface SmsQueueDispatchReport {
  referenceId: string;
  queuedMessages: number;
  providerQuotaPerMin: number;
  dlqRetryCount: number;
  utilizationBps: number;
  status: 'healthy' | 'degraded' | 'halted';
  summary: string;
  checksumHex: string;
}

export function evaluateSmsNotificationRateQueue(input: SmsQueueDispatchReportInput): SmsQueueDispatchReport {
  const referenceId = input.referenceId.trim();
  if (!referenceId) {
    throw new Error('evaluateSmsNotificationRateQueue: referenceId is required');
  }
  if (
    !Number.isFinite(input.queuedMessages) ||
    !Number.isFinite(input.providerQuotaPerMin) ||
    !Number.isFinite(input.dlqRetryCount)
  ) {
    throw new Error('evaluateSmsNotificationRateQueue: numeric inputs must be finite');
  }

  const v1 = Math.max(0, Math.trunc(input.queuedMessages));
  const v2 = Math.max(0, Math.trunc(input.providerQuotaPerMin));
  const v3 = Math.max(0, Math.trunc(input.dlqRetryCount));
  const limit = Math.max(1, Math.trunc(input.thresholdLimit ?? 1000));

  const utilizationBps = Math.min(10000, Math.round(((v1 + v2) * 10000) / limit));
  let status: 'healthy' | 'degraded' | 'halted' = 'healthy';
  let summary = `nominal (queuedMessages=${v1}, providerQuotaPerMin=${v2}, dlqRetryCount=${v3})`;

  if (v3 > limit || utilizationBps >= 9000) {
    status = 'halted';
    summary = `limit exceeded: utilization=${utilizationBps}bps, dlqRetryCount=${v3} > ${limit}`;
  } else if (utilizationBps >= 5000) {
    status = 'degraded';
    summary = `elevated utilization=${utilizationBps}bps for ${referenceId}`;
  }

  const canonical = JSON.stringify({
    referenceId,
    queuedMessages: v1,
    providerQuotaPerMin: v2,
    dlqRetryCount: v3,
    utilizationBps,
    status,
    summary,
  });
  const checksumHex = createHash('sha256').update(canonical).digest('hex');

  return {
    referenceId,
    queuedMessages: v1,
    providerQuotaPerMin: v2,
    dlqRetryCount: v3,
    utilizationBps,
    status,
    summary,
    checksumHex,
  };
}
