import { describe, it, expect, vi, beforeEach } from 'vitest';
import { FraudAnalyticsService } from './analyticsService.js';
import { FraudCheckResult } from '../models/FraudCheckResult.js';
import { FraudCase } from '../models/FraudCase.js';

vi.mock('../models/FraudCheckResult.js');
vi.mock('../models/FraudCase.js');
vi.mock('@delegolabs/utils', () => ({ createLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn() }) }));

describe('FraudAnalyticsService — fraud analytics aggregation', () => {
  let service: FraudAnalyticsService;

  beforeEach(() => {
    service = new FraudAnalyticsService();
    vi.clearAllMocks();
  });

  // ── getFraudRateMetrics ───────────────────────────────────────────────────

  it('returns zero fraud rate when no transactions exist', async () => {
    vi.mocked(FraudCheckResult.count).mockResolvedValue(0);
    vi.mocked(FraudCase.count).mockResolvedValue(0);
    vi.mocked(FraudCheckResult.findOne).mockResolvedValue(null);
    vi.mocked(FraudCheckResult.findAll).mockResolvedValue([]);

    const result = await service.getFraudRateMetrics(30);

    expect(result.fraudRate).toBe(0);
    expect(result.totalTransactions).toBe(0);
    expect(result.flaggedTransactions).toBe(0);
  });

  it('computes fraud rate as flagged / total', async () => {
    vi.mocked(FraudCheckResult.count)
      .mockResolvedValueOnce(100)  // total
      .mockResolvedValueOnce(20);  // flagged
    vi.mocked(FraudCase.count).mockResolvedValue(10);
    vi.mocked(FraudCheckResult.findOne).mockResolvedValue({ average: '45.5' } as any);
    vi.mocked(FraudCheckResult.findAll).mockResolvedValue([]);

    const result = await service.getFraudRateMetrics(30);

    expect(result.totalTransactions).toBe(100);
    expect(result.flaggedTransactions).toBe(20);
    expect(result.fraudConfirmed).toBe(10);
    expect(result.fraudRate).toBeCloseTo(0.2);
  });

  it('parses averageScore from the aggregation result', async () => {
    vi.mocked(FraudCheckResult.count).mockResolvedValue(50);
    vi.mocked(FraudCase.count).mockResolvedValue(5);
    vi.mocked(FraudCheckResult.findOne).mockResolvedValue({ average: '72.3' } as any);
    vi.mocked(FraudCheckResult.findAll).mockResolvedValue([]);

    const result = await service.getFraudRateMetrics(30);
    expect(result.averageScore).toBeCloseTo(72.3);
  });

  it('defaults averageScore to 0 when no aggregation row is returned', async () => {
    vi.mocked(FraudCheckResult.count).mockResolvedValue(10);
    vi.mocked(FraudCase.count).mockResolvedValue(0);
    vi.mocked(FraudCheckResult.findOne).mockResolvedValue(null);
    vi.mocked(FraudCheckResult.findAll).mockResolvedValue([]);

    const result = await service.getFraudRateMetrics(30);
    expect(result.averageScore).toBe(0);
  });

  // ── getAnalyticsMetrics ───────────────────────────────────────────────────

  it('getAnalyticsMetrics returns a subset of getFraudRateMetrics', async () => {
    vi.mocked(FraudCheckResult.count).mockResolvedValue(80).mockResolvedValueOnce(80).mockResolvedValueOnce(16);
    vi.mocked(FraudCase.count).mockResolvedValue(8);
    vi.mocked(FraudCheckResult.findOne).mockResolvedValue({ average: '60' } as any);
    vi.mocked(FraudCheckResult.findAll).mockResolvedValue([]);

    const metrics = await service.getAnalyticsMetrics();

    expect(metrics).toHaveProperty('totalTransactions');
    expect(metrics).toHaveProperty('flaggedTransactions');
    expect(metrics).toHaveProperty('fraudRate');
    expect(metrics).toHaveProperty('byTimePeriod');
    expect(metrics).toHaveProperty('byChannel');
  });

  // ── getTopFraudRules ──────────────────────────────────────────────────────

  it('returns top N rules sorted by trigger count', async () => {
    vi.mocked(FraudCheckResult.findAll).mockResolvedValue([
      { rulesTriggered: ['velocity_check', 'amount_threshold'], score: 80 } as any,
      { rulesTriggered: ['velocity_check'], score: 70 } as any,
      { rulesTriggered: ['amount_threshold'], score: 60 } as any,
    ]);

    const rules = await service.getTopFraudRules(5);

    expect(rules[0].ruleName).toBe('velocity_check');
    expect(rules[0].triggerCount).toBe(2);
    expect(rules.length).toBeLessThanOrEqual(5);
  });

  it('returns empty array when no flagged results exist', async () => {
    vi.mocked(FraudCheckResult.findAll).mockResolvedValue([]);
    const rules = await service.getTopFraudRules(10);
    expect(rules).toEqual([]);
  });

  it('computes avgScoreImpact as the mean of triggered-rule scores', async () => {
    vi.mocked(FraudCheckResult.findAll).mockResolvedValue([
      { rulesTriggered: ['rule_a'], score: 60 } as any,
      { rulesTriggered: ['rule_a'], score: 80 } as any,
    ]);

    const rules = await service.getTopFraudRules(5);
    const ruleA = rules.find((r) => r.ruleName === 'rule_a');
    expect(ruleA?.avgScoreImpact).toBe(70);
  });

  // ── getFalsePositiveRate ──────────────────────────────────────────────────

  it('returns 0 when no cases have been resolved', async () => {
    vi.mocked(FraudCase.count).mockResolvedValue(0);
    const rate = await service.getFalsePositiveRate();
    expect(rate).toBe(0);
  });

  it('computes false-positive rate as falsePositive / resolved', async () => {
    vi.mocked(FraudCase.count)
      .mockResolvedValueOnce(10)   // false_positive
      .mockResolvedValueOnce(40);  // all resolved

    const rate = await service.getFalsePositiveRate();
    expect(rate).toBeCloseTo(0.25);
  });

  // ── getModelPerformance ───────────────────────────────────────────────────

  it('returns performance metrics with all required fields', async () => {
    const perf = await service.getModelPerformance();
    expect(perf).toHaveProperty('precision');
    expect(perf).toHaveProperty('recall');
    expect(perf).toHaveProperty('f1Score');
    expect(perf).toHaveProperty('accuracy');
    expect(perf).toHaveProperty('falsePositiveRate');
  });

  it('returns F1 score >= 0 and <= 1', async () => {
    const perf = await service.getModelPerformance();
    expect(perf.f1Score).toBeGreaterThanOrEqual(0);
    expect(perf.f1Score).toBeLessThanOrEqual(1);
  });
});
