import { describe, it, expect, vi, beforeEach } from 'vitest';
import { ExchangeRateService } from './exchangeRateService.js';

describe('ExchangeRateService', () => {
  let service: any;
  let cacheRepo: any;
  let rateProvider: any;
  let logger: any;

  beforeEach(() => {
    cacheRepo = {
      get: vi.fn(),
      set: vi.fn(),
      getExpired: vi.fn(),
      deleteExpired: vi.fn(),
    };
    rateProvider = {
      fetchRate: vi.fn(),
      fetchRatesForDate: vi.fn(),
    };
    logger = { warn: vi.fn(), info: vi.fn(), error: vi.fn() };
    service = new ExchangeRateService(cacheRepo, rateProvider, logger);
  });

  it('should instantiate', () => {
    expect(service).toBeDefined();
  });

  it('getRate returns cached rate when present', async () => {
    cacheRepo.get.mockResolvedValue({ rate: 1.25, expiresAt: Date.now() + 60_000 });
    const rate = await service.getRate('USD', 'EUR', '2024-01-01');
    expect(rate).toBe(1.25);
    expect(rateProvider.fetchRate).not.toHaveBeenCalled();
  });

  it('getRate falls back to provider when cache misses and caches result', async () => {
    cacheRepo.get.mockResolvedValue(undefined);
    rateProvider.fetchRate.mockResolvedValue(1.1);
    const rate = await service.getRate('USD', 'EUR', '2024-01-01');
    expect(rate).toBe(1.1);
    expect(rateProvider.fetchRate).toHaveBeenCalledWith('USD', 'EUR', '2024-01-01');
    expect(cacheRepo.set).toHaveBeenCalled();
  });

  it('getRate propagates provider errors when cache misses', async () => {
    cacheRepo.get.mockResolvedValue(undefined);
    rateProvider.fetchRate.mockRejectedValue(new Error('upstream down'));
    await expect(service.getRate('USD', 'EUR', '2024-01-01')).rejects.toThrow('upstream down');
  });

  it('getRateFromCache returns undefined when entry is missing', async () => {
    cacheRepo.get.mockResolvedValue(undefined);
    const rate = await service.getRateFromCache('USD', 'EUR', '2024-01-01');
    expect(rate).toBeUndefined();
  });

  it('fetchRate delegates to the rate provider', async () => {
    rateProvider.fetchRate.mockResolvedValue(0.9);
    const rate = await service.fetchRate('EUR', 'USD', '2024-01-01');
    expect(rate).toBe(0.9);
    expect(rateProvider.fetchRate).toHaveBeenCalledWith('EUR', 'USD', '2024-01-01');
  });

  it('convertAmount multiplies amount by resolved rate', async () => {
    cacheRepo.get.mockResolvedValue({ rate: 2, expiresAt: Date.now() + 60_000 });
    const converted = await service.convertAmount(10, 'USD', 'EUR', '2024-01-01');
    expect(converted).toBe(20);
  });

  it('refreshExpiredRates deletes expired entries', async () => {
    cacheRepo.getExpired.mockResolvedValue([{ base: 'USD', quote: 'EUR', date: '2024-01-01' }]);
    rateProvider.fetchRate.mockResolvedValue(1.2);
    await service.refreshExpiredRates();
    expect(cacheRepo.deleteExpired).toHaveBeenCalled();
  });
});
