import { createHash } from 'node:crypto';

export interface ParsedScValSummaryInput {
  referenceId: string;
  mapEntryCount: number;
  vectorLength: number;
  decodeErrorCount: number;
  thresholdLimit?: number;
}

export interface ParsedScValSummary {
  referenceId: string;
  mapEntryCount: number;
  vectorLength: number;
  decodeErrorCount: number;
  utilizationBps: number;
  status: 'healthy' | 'degraded' | 'halted';
  summary: string;
  checksumHex: string;
}

export function parseTypedSorobanScValSummary(input: ParsedScValSummaryInput): ParsedScValSummary {
  const referenceId = input.referenceId.trim();
  if (!referenceId) {
    throw new Error('parseTypedSorobanScValSummary: referenceId is required');
  }
  if (
    !Number.isFinite(input.mapEntryCount) ||
    !Number.isFinite(input.vectorLength) ||
    !Number.isFinite(input.decodeErrorCount)
  ) {
    throw new Error('parseTypedSorobanScValSummary: numeric inputs must be finite');
  }

  const v1 = Math.max(0, Math.trunc(input.mapEntryCount));
  const v2 = Math.max(0, Math.trunc(input.vectorLength));
  const v3 = Math.max(0, Math.trunc(input.decodeErrorCount));
  const limit = Math.max(1, Math.trunc(input.thresholdLimit ?? 1000));

  const utilizationBps = Math.min(10000, Math.round(((v1 + v2) * 10000) / limit));
  let status: 'healthy' | 'degraded' | 'halted' = 'healthy';
  let summary = `nominal (mapEntryCount=${v1}, vectorLength=${v2}, decodeErrorCount=${v3})`;

  if (v3 > limit || utilizationBps >= 9000) {
    status = 'halted';
    summary = `limit exceeded: utilization=${utilizationBps}bps, decodeErrorCount=${v3} > ${limit}`;
  } else if (utilizationBps >= 5000) {
    status = 'degraded';
    summary = `elevated utilization=${utilizationBps}bps for ${referenceId}`;
  }

  const canonical = JSON.stringify({
    referenceId,
    mapEntryCount: v1,
    vectorLength: v2,
    decodeErrorCount: v3,
    utilizationBps,
    status,
    summary,
  });
  const checksumHex = createHash('sha256').update(canonical).digest('hex');

  return {
    referenceId,
    mapEntryCount: v1,
    vectorLength: v2,
    decodeErrorCount: v3,
    utilizationBps,
    status,
    summary,
    checksumHex,
  };
}
