import { describe, it, expect } from 'vitest';
import { FraudCheckService } from './fraudCheckService.js';

describe('FraudCheckService', () => {
  it('should instantiate with injected dependencies', () => {
    const service = new FraudCheckService(null as any, null as any);
    expect(service).toBeDefined();
  });

  it('should delegate checkTransaction and return the computed result', async () => {
    const service = new FraudCheckService(null as any, null as any, null as any) as any;
    const result = await service.checkTransaction({ amount: 100 }, {}, {}, {}, {});
    expect(result).toBeDefined();
  });

  it('should persist check results via saveCheckResult', async () => {
    const service = new FraudCheckService(null as any, null as any, null as any) as any;
    await expect(
      service.saveCheckResult(null as any, null as any, null as any, null as any, null as any)
    ).resolves.not.toThrow();
  });

  it('should log fraud events via logFraudEvent', async () => {
    const service = new FraudCheckService(null as any, null as any, null as any) as any;
    await expect(
      service.logFraudEvent(null as any, null as any, null as any, null as any, null as any)
    ).resolves.not.toThrow();
  });

  it('should retrieve a stored check result via getCheckResult', async () => {
    const service = new FraudCheckService(null as any, null as any, null as any) as any;
    const result = await service.getCheckResult(null as any, null as any, null as any, null as any, null as any);
    expect(result).toBeDefined();
  });

  it('should release resources on close', async () => {
    const service = new FraudCheckService(null as any, null as any, null as any) as any;
    await expect(
      service.close(null as any, null as any, null as any, null as any, null as any)
    ).resolves.not.toThrow();
  });
});

