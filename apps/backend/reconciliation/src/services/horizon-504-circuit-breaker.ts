import { createHash } from 'node:crypto';

export interface HorizonCircuitStateInput {
  referenceId: string;
  consecutive504Count: number;
  cooldownRemainingMs: number;
  latencyMs: number;
  thresholdLimit?: number;
}

export interface HorizonCircuitState {
  referenceId: string;
  consecutive504Count: number;
  cooldownRemainingMs: number;
  latencyMs: number;
  utilizationBps: number;
  status: 'healthy' | 'degraded' | 'halted';
  summary: string;
  checksumHex: string;
}

export function evaluateHorizonCircuitBreaker(input: HorizonCircuitStateInput): HorizonCircuitState {
  const referenceId = input.referenceId.trim();
  if (!referenceId) {
    throw new Error('evaluateHorizonCircuitBreaker: referenceId is required');
  }
  if (
    !Number.isFinite(input.consecutive504Count) ||
    !Number.isFinite(input.cooldownRemainingMs) ||
    !Number.isFinite(input.latencyMs)
  ) {
    throw new Error('evaluateHorizonCircuitBreaker: numeric inputs must be finite');
  }

  const v1 = Math.max(0, Math.trunc(input.consecutive504Count));
  const v2 = Math.max(0, Math.trunc(input.cooldownRemainingMs));
  const v3 = Math.max(0, Math.trunc(input.latencyMs));
  const limit = Math.max(1, Math.trunc(input.thresholdLimit ?? 1000));

  const utilizationBps = Math.min(10000, Math.round(((v1 + v2) * 10000) / limit));
  let status: 'healthy' | 'degraded' | 'halted' = 'healthy';
  let summary = `nominal (consecutive504Count=${v1}, cooldownRemainingMs=${v2}, latencyMs=${v3})`;

  if (v3 > limit || utilizationBps >= 9000) {
    status = 'halted';
    summary = `limit exceeded: utilization=${utilizationBps}bps, latencyMs=${v3} > ${limit}`;
  } else if (utilizationBps >= 5000) {
    status = 'degraded';
    summary = `elevated utilization=${utilizationBps}bps for ${referenceId}`;
  }

  const canonical = JSON.stringify({
    referenceId,
    consecutive504Count: v1,
    cooldownRemainingMs: v2,
    latencyMs: v3,
    utilizationBps,
    status,
    summary,
  });
  const checksumHex = createHash('sha256').update(canonical).digest('hex');

  return {
    referenceId,
    consecutive504Count: v1,
    cooldownRemainingMs: v2,
    latencyMs: v3,
    utilizationBps,
    status,
    summary,
    checksumHex,
  };
}
