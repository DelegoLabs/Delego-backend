import { createHash } from 'node:crypto';

export interface HorizonMockFallbackVerdictInput {
  referenceId: string;
  primaryEndpointFailures: number;
  mockFallbackActiveFlag: number;
  timeoutMs: number;
  thresholdLimit?: number;
}

export interface HorizonMockFallbackVerdict {
  referenceId: string;
  primaryEndpointFailures: number;
  mockFallbackActiveFlag: number;
  timeoutMs: number;
  utilizationBps: number;
  status: 'healthy' | 'degraded' | 'halted';
  summary: string;
  checksumHex: string;
}

export function resolveGatewayHorizonRpcFallback(input: HorizonMockFallbackVerdictInput): HorizonMockFallbackVerdict {
  const referenceId = input.referenceId.trim();
  if (!referenceId) {
    throw new Error('resolveGatewayHorizonRpcFallback: referenceId is required');
  }
  if (
    !Number.isFinite(input.primaryEndpointFailures) ||
    !Number.isFinite(input.mockFallbackActiveFlag) ||
    !Number.isFinite(input.timeoutMs)
  ) {
    throw new Error('resolveGatewayHorizonRpcFallback: numeric inputs must be finite');
  }

  const v1 = Math.max(0, Math.trunc(input.primaryEndpointFailures));
  const v2 = Math.max(0, Math.trunc(input.mockFallbackActiveFlag));
  const v3 = Math.max(0, Math.trunc(input.timeoutMs));
  const limit = Math.max(1, Math.trunc(input.thresholdLimit ?? 1000));

  const utilizationBps = Math.min(10000, Math.round(((v1 + v2) * 10000) / limit));
  let status: 'healthy' | 'degraded' | 'halted' = 'healthy';
  let summary = `nominal (primaryEndpointFailures=${v1}, mockFallbackActiveFlag=${v2}, timeoutMs=${v3})`;

  if (v3 > limit || utilizationBps >= 9000) {
    status = 'halted';
    summary = `limit exceeded: utilization=${utilizationBps}bps, timeoutMs=${v3} > ${limit}`;
  } else if (utilizationBps >= 5000) {
    status = 'degraded';
    summary = `elevated utilization=${utilizationBps}bps for ${referenceId}`;
  }

  const canonical = JSON.stringify({
    referenceId,
    primaryEndpointFailures: v1,
    mockFallbackActiveFlag: v2,
    timeoutMs: v3,
    utilizationBps,
    status,
    summary,
  });
  const checksumHex = createHash('sha256').update(canonical).digest('hex');

  return {
    referenceId,
    primaryEndpointFailures: v1,
    mockFallbackActiveFlag: v2,
    timeoutMs: v3,
    utilizationBps,
    status,
    summary,
    checksumHex,
  };
}
