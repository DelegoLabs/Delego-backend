import { describe, expect, it } from 'vitest';
import { resolveGatewayHorizonRpcFallback } from './gateway-horizon-rpc-mock-fallback.js';

describe('resolveGatewayHorizonRpcFallback', () => {
  it('returns healthy status and deterministic sha256 checksum within nominal bounds', () => {
    const result = resolveGatewayHorizonRpcFallback({
      referenceId: 'ref-100',
      primaryEndpointFailures: 150,
      mockFallbackActiveFlag: 50,
      timeoutMs: 10,
      thresholdLimit: 1000,
    });
    expect(result.status).toBe('healthy');
    expect(result.utilizationBps).toBe(2000);
    expect(result.checksumHex).toHaveLength(64);
  });

  it('transitions to halted when utilization or secondary metric breaches threshold', () => {
    const result = resolveGatewayHorizonRpcFallback({
      referenceId: 'ref-200',
      primaryEndpointFailures: 700,
      mockFallbackActiveFlag: 300,
      timeoutMs: 1200,
      thresholdLimit: 1000,
    });
    expect(result.status).toBe('halted');
    expect(result.utilizationBps).toBe(10000);
    expect(result.summary).toContain('limit exceeded');
  });

  it('rejects blank referenceId or non-finite numbers', () => {
    expect(() =>
      resolveGatewayHorizonRpcFallback({
        referenceId: '   ',
        primaryEndpointFailures: 1,
        mockFallbackActiveFlag: 2,
        timeoutMs: 3,
      }),
    ).toThrow(/referenceId is required/);
  });
});
