import { createHash } from 'node:crypto';

export interface QueryLogSanitizationResultInput {
  referenceId: string;
  parameterCount: number;
  redactedTokenCount: number;
  rawQueryLength: number;
  thresholdLimit?: number;
}

export interface QueryLogSanitizationResult {
  referenceId: string;
  parameterCount: number;
  redactedTokenCount: number;
  rawQueryLength: number;
  utilizationBps: number;
  status: 'healthy' | 'degraded' | 'halted';
  summary: string;
  checksumHex: string;
}

export function scanAndRedactQueryLogSecrets(input: QueryLogSanitizationResultInput): QueryLogSanitizationResult {
  const referenceId = input.referenceId.trim();
  if (!referenceId) {
    throw new Error('scanAndRedactQueryLogSecrets: referenceId is required');
  }
  if (
    !Number.isFinite(input.parameterCount) ||
    !Number.isFinite(input.redactedTokenCount) ||
    !Number.isFinite(input.rawQueryLength)
  ) {
    throw new Error('scanAndRedactQueryLogSecrets: numeric inputs must be finite');
  }

  const v1 = Math.max(0, Math.trunc(input.parameterCount));
  const v2 = Math.max(0, Math.trunc(input.redactedTokenCount));
  const v3 = Math.max(0, Math.trunc(input.rawQueryLength));
  const limit = Math.max(1, Math.trunc(input.thresholdLimit ?? 1000));

  const utilizationBps = Math.min(10000, Math.round(((v1 + v2) * 10000) / limit));
  let status: 'healthy' | 'degraded' | 'halted' = 'healthy';
  let summary = `nominal (parameterCount=${v1}, redactedTokenCount=${v2}, rawQueryLength=${v3})`;

  if (v3 > limit || utilizationBps >= 9000) {
    status = 'halted';
    summary = `limit exceeded: utilization=${utilizationBps}bps, rawQueryLength=${v3} > ${limit}`;
  } else if (utilizationBps >= 5000) {
    status = 'degraded';
    summary = `elevated utilization=${utilizationBps}bps for ${referenceId}`;
  }

  const canonical = JSON.stringify({
    referenceId,
    parameterCount: v1,
    redactedTokenCount: v2,
    rawQueryLength: v3,
    utilizationBps,
    status,
    summary,
  });
  const checksumHex = createHash('sha256').update(canonical).digest('hex');

  return {
    referenceId,
    parameterCount: v1,
    redactedTokenCount: v2,
    rawQueryLength: v3,
    utilizationBps,
    status,
    summary,
    checksumHex,
  };
}
