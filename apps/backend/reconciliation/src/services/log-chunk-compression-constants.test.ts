import { describe, expect, it } from 'vitest';
import { resolveLogChunkCompressionConfig } from './log-chunk-compression-constants.js';

describe('resolveLogChunkCompressionConfig', () => {
  it('returns healthy status and deterministic sha256 checksum within nominal bounds', () => {
    const result = resolveLogChunkCompressionConfig({
      referenceId: 'ref-100',
      uncompressedBytes: 150,
      compressionLevel: 50,
      chunkThresholdBytes: 10,
      thresholdLimit: 1000,
    });
    expect(result.status).toBe('healthy');
    expect(result.utilizationBps).toBe(2000);
    expect(result.checksumHex).toHaveLength(64);
  });

  it('transitions to halted when utilization or secondary metric breaches threshold', () => {
    const result = resolveLogChunkCompressionConfig({
      referenceId: 'ref-200',
      uncompressedBytes: 700,
      compressionLevel: 300,
      chunkThresholdBytes: 1200,
      thresholdLimit: 1000,
    });
    expect(result.status).toBe('halted');
    expect(result.utilizationBps).toBe(10000);
    expect(result.summary).toContain('limit exceeded');
  });

  it('rejects blank referenceId or non-finite numbers', () => {
    expect(() =>
      resolveLogChunkCompressionConfig({
        referenceId: '   ',
        uncompressedBytes: 1,
        compressionLevel: 2,
        chunkThresholdBytes: 3,
      }),
    ).toThrow(/referenceId is required/);
  });
});
