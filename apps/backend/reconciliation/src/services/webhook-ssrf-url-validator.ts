import { createHash } from 'node:crypto';

export interface WebhookUrlSafetyReportInput {
  referenceId: string;
  resolvedIpClassCode: number;
  portNumber: number;
  redirectHopCount: number;
  thresholdLimit?: number;
}

export interface WebhookUrlSafetyReport {
  referenceId: string;
  resolvedIpClassCode: number;
  portNumber: number;
  redirectHopCount: number;
  utilizationBps: number;
  status: 'healthy' | 'degraded' | 'halted';
  summary: string;
  checksumHex: string;
}

export function validateMerchantWebhookUrl(input: WebhookUrlSafetyReportInput): WebhookUrlSafetyReport {
  const referenceId = input.referenceId.trim();
  if (!referenceId) {
    throw new Error('validateMerchantWebhookUrl: referenceId is required');
  }
  if (
    !Number.isFinite(input.resolvedIpClassCode) ||
    !Number.isFinite(input.portNumber) ||
    !Number.isFinite(input.redirectHopCount)
  ) {
    throw new Error('validateMerchantWebhookUrl: numeric inputs must be finite');
  }

  const v1 = Math.max(0, Math.trunc(input.resolvedIpClassCode));
  const v2 = Math.max(0, Math.trunc(input.portNumber));
  const v3 = Math.max(0, Math.trunc(input.redirectHopCount));
  const limit = Math.max(1, Math.trunc(input.thresholdLimit ?? 1000));

  const utilizationBps = Math.min(10000, Math.round(((v1 + v2) * 10000) / limit));
  let status: 'healthy' | 'degraded' | 'halted' = 'healthy';
  let summary = `nominal (resolvedIpClassCode=${v1}, portNumber=${v2}, redirectHopCount=${v3})`;

  if (v3 > limit || utilizationBps >= 9000) {
    status = 'halted';
    summary = `limit exceeded: utilization=${utilizationBps}bps, redirectHopCount=${v3} > ${limit}`;
  } else if (utilizationBps >= 5000) {
    status = 'degraded';
    summary = `elevated utilization=${utilizationBps}bps for ${referenceId}`;
  }

  const canonical = JSON.stringify({
    referenceId,
    resolvedIpClassCode: v1,
    portNumber: v2,
    redirectHopCount: v3,
    utilizationBps,
    status,
    summary,
  });
  const checksumHex = createHash('sha256').update(canonical).digest('hex');

  return {
    referenceId,
    resolvedIpClassCode: v1,
    portNumber: v2,
    redirectHopCount: v3,
    utilizationBps,
    status,
    summary,
    checksumHex,
  };
}
