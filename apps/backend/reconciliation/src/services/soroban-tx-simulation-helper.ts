import { createHash } from 'node:crypto';

export interface SimulationResourceVerdictInput {
  referenceId: string;
  cpuInstructions: number;
  readWriteBytes: number;
  safetyMarginBps: number;
  thresholdLimit?: number;
}

export interface SimulationResourceVerdict {
  referenceId: string;
  cpuInstructions: number;
  readWriteBytes: number;
  safetyMarginBps: number;
  utilizationBps: number;
  status: 'healthy' | 'degraded' | 'halted';
  summary: string;
  checksumHex: string;
}

export function evaluateSorobanSimulationResources(input: SimulationResourceVerdictInput): SimulationResourceVerdict {
  const referenceId = input.referenceId.trim();
  if (!referenceId) {
    throw new Error('evaluateSorobanSimulationResources: referenceId is required');
  }
  if (
    !Number.isFinite(input.cpuInstructions) ||
    !Number.isFinite(input.readWriteBytes) ||
    !Number.isFinite(input.safetyMarginBps)
  ) {
    throw new Error('evaluateSorobanSimulationResources: numeric inputs must be finite');
  }

  const v1 = Math.max(0, Math.trunc(input.cpuInstructions));
  const v2 = Math.max(0, Math.trunc(input.readWriteBytes));
  const v3 = Math.max(0, Math.trunc(input.safetyMarginBps));
  const limit = Math.max(1, Math.trunc(input.thresholdLimit ?? 1000));

  const utilizationBps = Math.min(10000, Math.round(((v1 + v2) * 10000) / limit));
  let status: 'healthy' | 'degraded' | 'halted' = 'healthy';
  let summary = `nominal (cpuInstructions=${v1}, readWriteBytes=${v2}, safetyMarginBps=${v3})`;

  if (v3 > limit || utilizationBps >= 9000) {
    status = 'halted';
    summary = `limit exceeded: utilization=${utilizationBps}bps, safetyMarginBps=${v3} > ${limit}`;
  } else if (utilizationBps >= 5000) {
    status = 'degraded';
    summary = `elevated utilization=${utilizationBps}bps for ${referenceId}`;
  }

  const canonical = JSON.stringify({
    referenceId,
    cpuInstructions: v1,
    readWriteBytes: v2,
    safetyMarginBps: v3,
    utilizationBps,
    status,
    summary,
  });
  const checksumHex = createHash('sha256').update(canonical).digest('hex');

  return {
    referenceId,
    cpuInstructions: v1,
    readWriteBytes: v2,
    safetyMarginBps: v3,
    utilizationBps,
    status,
    summary,
    checksumHex,
  };
}
