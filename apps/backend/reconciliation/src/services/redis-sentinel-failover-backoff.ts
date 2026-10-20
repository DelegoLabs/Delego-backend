import { createHash } from 'node:crypto';

export interface SentinelFailoverStateInput {
  referenceId: string;
  reconnectAttemptCount: number;
  quorumReachableNodes: number;
  stormWindowEvents: number;
  thresholdLimit?: number;
}

export interface SentinelFailoverState {
  referenceId: string;
  reconnectAttemptCount: number;
  quorumReachableNodes: number;
  stormWindowEvents: number;
  utilizationBps: number;
  status: 'healthy' | 'degraded' | 'halted';
  summary: string;
  checksumHex: string;
}

export function evaluateSentinelReconnectBackoff(input: SentinelFailoverStateInput): SentinelFailoverState {
  const referenceId = input.referenceId.trim();
  if (!referenceId) {
    throw new Error('evaluateSentinelReconnectBackoff: referenceId is required');
  }
  if (
    !Number.isFinite(input.reconnectAttemptCount) ||
    !Number.isFinite(input.quorumReachableNodes) ||
    !Number.isFinite(input.stormWindowEvents)
  ) {
    throw new Error('evaluateSentinelReconnectBackoff: numeric inputs must be finite');
  }

  const v1 = Math.max(0, Math.trunc(input.reconnectAttemptCount));
  const v2 = Math.max(0, Math.trunc(input.quorumReachableNodes));
  const v3 = Math.max(0, Math.trunc(input.stormWindowEvents));
  const limit = Math.max(1, Math.trunc(input.thresholdLimit ?? 1000));

  const utilizationBps = Math.min(10000, Math.round(((v1 + v2) * 10000) / limit));
  let status: 'healthy' | 'degraded' | 'halted' = 'healthy';
  let summary = `nominal (reconnectAttemptCount=${v1}, quorumReachableNodes=${v2}, stormWindowEvents=${v3})`;

  if (v3 > limit || utilizationBps >= 9000) {
    status = 'halted';
    summary = `limit exceeded: utilization=${utilizationBps}bps, stormWindowEvents=${v3} > ${limit}`;
  } else if (utilizationBps >= 5000) {
    status = 'degraded';
    summary = `elevated utilization=${utilizationBps}bps for ${referenceId}`;
  }

  const canonical = JSON.stringify({
    referenceId,
    reconnectAttemptCount: v1,
    quorumReachableNodes: v2,
    stormWindowEvents: v3,
    utilizationBps,
    status,
    summary,
  });
  const checksumHex = createHash('sha256').update(canonical).digest('hex');

  return {
    referenceId,
    reconnectAttemptCount: v1,
    quorumReachableNodes: v2,
    stormWindowEvents: v3,
    utilizationBps,
    status,
    summary,
    checksumHex,
  };
}
