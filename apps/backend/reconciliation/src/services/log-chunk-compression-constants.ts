import { createHash } from 'node:crypto';

export interface LogChunkCompressionSpecInput {
  referenceId: string;
  uncompressedBytes: number;
  compressionLevel: number;
  chunkThresholdBytes: number;
  thresholdLimit?: number;
}

export interface LogChunkCompressionSpec {
  referenceId: string;
  uncompressedBytes: number;
  compressionLevel: number;
  chunkThresholdBytes: number;
  utilizationBps: number;
  status: 'healthy' | 'degraded' | 'halted';
  summary: string;
  checksumHex: string;
}

export function resolveLogChunkCompressionConfig(input: LogChunkCompressionSpecInput): LogChunkCompressionSpec {
  const referenceId = input.referenceId.trim();
  if (!referenceId) {
    throw new Error('resolveLogChunkCompressionConfig: referenceId is required');
  }
  if (
    !Number.isFinite(input.uncompressedBytes) ||
    !Number.isFinite(input.compressionLevel) ||
    !Number.isFinite(input.chunkThresholdBytes)
  ) {
    throw new Error('resolveLogChunkCompressionConfig: numeric inputs must be finite');
  }

  const v1 = Math.max(0, Math.trunc(input.uncompressedBytes));
  const v2 = Math.max(0, Math.trunc(input.compressionLevel));
  const v3 = Math.max(0, Math.trunc(input.chunkThresholdBytes));
  const limit = Math.max(1, Math.trunc(input.thresholdLimit ?? 1000));

  const utilizationBps = Math.min(10000, Math.round(((v1 + v2) * 10000) / limit));
  let status: 'healthy' | 'degraded' | 'halted' = 'healthy';
  let summary = `nominal (uncompressedBytes=${v1}, compressionLevel=${v2}, chunkThresholdBytes=${v3})`;

  if (v3 > limit || utilizationBps >= 9000) {
    status = 'halted';
    summary = `limit exceeded: utilization=${utilizationBps}bps, chunkThresholdBytes=${v3} > ${limit}`;
  } else if (utilizationBps >= 5000) {
    status = 'degraded';
    summary = `elevated utilization=${utilizationBps}bps for ${referenceId}`;
  }

  const canonical = JSON.stringify({
    referenceId,
    uncompressedBytes: v1,
    compressionLevel: v2,
    chunkThresholdBytes: v3,
    utilizationBps,
    status,
    summary,
  });
  const checksumHex = createHash('sha256').update(canonical).digest('hex');

  return {
    referenceId,
    uncompressedBytes: v1,
    compressionLevel: v2,
    chunkThresholdBytes: v3,
    utilizationBps,
    status,
    summary,
    checksumHex,
  };
}
