import { describe, expect, it } from 'vitest';
import { evaluateSmsNotificationRateQueue } from './bullmq-sms-notification-queue.js';

describe('evaluateSmsNotificationRateQueue', () => {
  it('returns healthy status and deterministic sha256 checksum within nominal bounds', () => {
    const result = evaluateSmsNotificationRateQueue({
      referenceId: 'ref-100',
      queuedMessages: 150,
      providerQuotaPerMin: 50,
      dlqRetryCount: 10,
      thresholdLimit: 1000,
    });
    expect(result.status).toBe('healthy');
    expect(result.utilizationBps).toBe(2000);
    expect(result.checksumHex).toHaveLength(64);
  });

  it('transitions to halted when utilization or secondary metric breaches threshold', () => {
    const result = evaluateSmsNotificationRateQueue({
      referenceId: 'ref-200',
      queuedMessages: 700,
      providerQuotaPerMin: 300,
      dlqRetryCount: 1200,
      thresholdLimit: 1000,
    });
    expect(result.status).toBe('halted');
    expect(result.utilizationBps).toBe(10000);
    expect(result.summary).toContain('limit exceeded');
  });

  it('rejects blank referenceId or non-finite numbers', () => {
    expect(() =>
      evaluateSmsNotificationRateQueue({
        referenceId: '   ',
        queuedMessages: 1,
        providerQuotaPerMin: 2,
        dlqRetryCount: 3,
      }),
    ).toThrow(/referenceId is required/);
  });
});
