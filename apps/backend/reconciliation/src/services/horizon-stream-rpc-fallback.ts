import { createHash } from 'node:crypto';

export interface StreamFallbackStateInput {
  referenceId: string;
  disconnectCount: number;
  secondsSinceLastEvent: number;
  rpcPollIntervalMs: number;
  thresholdLimit?: number;
}

export interface StreamFallbackState {
  referenceId: string;
  disconnectCount: number;
  secondsSinceLastEvent: number;
  rpcPollIntervalMs: number;
  utilizationBps: number;
  status: 'healthy' | 'degraded' | 'halted';
  summary: string;
  checksumHex: string;
}

export function evaluateHorizonStreamFallback(input: StreamFallbackStateInput): StreamFallbackState {
  const referenceId = input.referenceId.trim();
  if (!referenceId) {
    throw new Error('evaluateHorizonStreamFallback: referenceId is required');
  }
  if (
    !Number.isFinite(input.disconnectCount) ||
    !Number.isFinite(input.secondsSinceLastEvent) ||
    !Number.isFinite(input.rpcPollIntervalMs)
  ) {
    throw new Error('evaluateHorizonStreamFallback: numeric inputs must be finite');
  }

  const v1 = Math.max(0, Math.trunc(input.disconnectCount));
  const v2 = Math.max(0, Math.trunc(input.secondsSinceLastEvent));
  const v3 = Math.max(0, Math.trunc(input.rpcPollIntervalMs));
  const limit = Math.max(1, Math.trunc(input.thresholdLimit ?? 1000));

  const utilizationBps = Math.min(10000, Math.round(((v1 + v2) * 10000) / limit));
  let status: 'healthy' | 'degraded' | 'halted' = 'healthy';
  let summary = `nominal (disconnectCount=${v1}, secondsSinceLastEvent=${v2}, rpcPollIntervalMs=${v3})`;

  if (v3 > limit || utilizationBps >= 9000) {
    status = 'halted';
    summary = `limit exceeded: utilization=${utilizationBps}bps, rpcPollIntervalMs=${v3} > ${limit}`;
  } else if (utilizationBps >= 5000) {
    status = 'degraded';
    summary = `elevated utilization=${utilizationBps}bps for ${referenceId}`;
  }

  const canonical = JSON.stringify({
    referenceId,
    disconnectCount: v1,
    secondsSinceLastEvent: v2,
    rpcPollIntervalMs: v3,
    utilizationBps,
    status,
    summary,
  });
  const checksumHex = createHash('sha256').update(canonical).digest('hex');

  return {
    referenceId,
    disconnectCount: v1,
    secondsSinceLastEvent: v2,
    rpcPollIntervalMs: v3,
    utilizationBps,
    status,
    summary,
    checksumHex,
  };
}
