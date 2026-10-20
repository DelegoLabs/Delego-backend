import { createHash } from 'node:crypto';

export interface GasPricePredictionInput {
  referenceId: string;
  p50FeeStroops: number;
  p95FeeStroops: number;
  ledgerSurgeUtilizationBps: number;
  thresholdLimit?: number;
}

export interface GasPricePrediction {
  referenceId: string;
  p50FeeStroops: number;
  p95FeeStroops: number;
  ledgerSurgeUtilizationBps: number;
  utilizationBps: number;
  status: 'healthy' | 'degraded' | 'halted';
  summary: string;
  checksumHex: string;
}

export function predictStellarFeePoolGasPrice(input: GasPricePredictionInput): GasPricePrediction {
  const referenceId = input.referenceId.trim();
  if (!referenceId) {
    throw new Error('predictStellarFeePoolGasPrice: referenceId is required');
  }
  if (
    !Number.isFinite(input.p50FeeStroops) ||
    !Number.isFinite(input.p95FeeStroops) ||
    !Number.isFinite(input.ledgerSurgeUtilizationBps)
  ) {
    throw new Error('predictStellarFeePoolGasPrice: numeric inputs must be finite');
  }

  const v1 = Math.max(0, Math.trunc(input.p50FeeStroops));
  const v2 = Math.max(0, Math.trunc(input.p95FeeStroops));
  const v3 = Math.max(0, Math.trunc(input.ledgerSurgeUtilizationBps));
  const limit = Math.max(1, Math.trunc(input.thresholdLimit ?? 1000));

  const utilizationBps = Math.min(10000, Math.round(((v1 + v2) * 10000) / limit));
  let status: 'healthy' | 'degraded' | 'halted' = 'healthy';
  let summary = `nominal (p50FeeStroops=${v1}, p95FeeStroops=${v2}, ledgerSurgeUtilizationBps=${v3})`;

  if (v3 > limit || utilizationBps >= 9000) {
    status = 'halted';
    summary = `limit exceeded: utilization=${utilizationBps}bps, ledgerSurgeUtilizationBps=${v3} > ${limit}`;
  } else if (utilizationBps >= 5000) {
    status = 'degraded';
    summary = `elevated utilization=${utilizationBps}bps for ${referenceId}`;
  }

  const canonical = JSON.stringify({
    referenceId,
    p50FeeStroops: v1,
    p95FeeStroops: v2,
    ledgerSurgeUtilizationBps: v3,
    utilizationBps,
    status,
    summary,
  });
  const checksumHex = createHash('sha256').update(canonical).digest('hex');

  return {
    referenceId,
    p50FeeStroops: v1,
    p95FeeStroops: v2,
    ledgerSurgeUtilizationBps: v3,
    utilizationBps,
    status,
    summary,
    checksumHex,
  };
}
