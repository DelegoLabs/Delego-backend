import { createHash } from 'node:crypto';

export interface CourierHmacVerificationInput {
  referenceId: string;
  signatureMatchFlag: number;
  timestampDriftSecs: number;
  bodyLengthBytes: number;
  thresholdLimit?: number;
}

export interface CourierHmacVerification {
  referenceId: string;
  signatureMatchFlag: number;
  timestampDriftSecs: number;
  bodyLengthBytes: number;
  utilizationBps: number;
  status: 'healthy' | 'degraded' | 'halted';
  summary: string;
  checksumHex: string;
}

export function verifyCourierWebhookSignature(input: CourierHmacVerificationInput): CourierHmacVerification {
  const referenceId = input.referenceId.trim();
  if (!referenceId) {
    throw new Error('verifyCourierWebhookSignature: referenceId is required');
  }
  if (
    !Number.isFinite(input.signatureMatchFlag) ||
    !Number.isFinite(input.timestampDriftSecs) ||
    !Number.isFinite(input.bodyLengthBytes)
  ) {
    throw new Error('verifyCourierWebhookSignature: numeric inputs must be finite');
  }

  const v1 = Math.max(0, Math.trunc(input.signatureMatchFlag));
  const v2 = Math.max(0, Math.trunc(input.timestampDriftSecs));
  const v3 = Math.max(0, Math.trunc(input.bodyLengthBytes));
  const limit = Math.max(1, Math.trunc(input.thresholdLimit ?? 1000));

  const utilizationBps = Math.min(10000, Math.round(((v1 + v2) * 10000) / limit));
  let status: 'healthy' | 'degraded' | 'halted' = 'healthy';
  let summary = `nominal (signatureMatchFlag=${v1}, timestampDriftSecs=${v2}, bodyLengthBytes=${v3})`;

  if (v3 > limit || utilizationBps >= 9000) {
    status = 'halted';
    summary = `limit exceeded: utilization=${utilizationBps}bps, bodyLengthBytes=${v3} > ${limit}`;
  } else if (utilizationBps >= 5000) {
    status = 'degraded';
    summary = `elevated utilization=${utilizationBps}bps for ${referenceId}`;
  }

  const canonical = JSON.stringify({
    referenceId,
    signatureMatchFlag: v1,
    timestampDriftSecs: v2,
    bodyLengthBytes: v3,
    utilizationBps,
    status,
    summary,
  });
  const checksumHex = createHash('sha256').update(canonical).digest('hex');

  return {
    referenceId,
    signatureMatchFlag: v1,
    timestampDriftSecs: v2,
    bodyLengthBytes: v3,
    utilizationBps,
    status,
    summary,
    checksumHex,
  };
}
