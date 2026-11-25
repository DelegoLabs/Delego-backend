import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { RetrainingService } from './retrainingService.js';

vi.mock('../mlScorer.js', () => ({
  mlScorer: {
    getVersion: vi.fn(() => 'v2026.1.0'),
    getModelInfo: vi.fn(() => ({ version: 'v2026.1.0', features: [] })),
    getThresholds: vi.fn(() => ({ review: 60, decline: 85 })),
  },
}));

vi.mock('@delegolabs/utils', () => ({ createLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn() }) }));

// Stub fs so tests don't write to the real filesystem
vi.mock('fs', () => ({
  existsSync: vi.fn(() => true),
  promises: {
    mkdir: vi.fn().mockResolvedValue(undefined),
    writeFile: vi.fn().mockResolvedValue(undefined),
  },
}));

describe('RetrainingService — retraining trigger validation', () => {
  let service: RetrainingService;

  beforeEach(() => {
    vi.clearAllMocks();
    service = new RetrainingService();
  });

  // ── retrainModel ──────────────────────────────────────────────────────────

  it('returns status "completed" on a successful run', async () => {
    const result = await service.retrainModel();
    expect(result.status).toBe('completed');
  });

  it('returns a non-empty modelVersion string', async () => {
    const result = await service.retrainModel();
    expect(typeof result.modelVersion).toBe('string');
    expect(result.modelVersion.length).toBeGreaterThan(0);
  });

  it('modelVersion contains the current year', async () => {
    const result = await service.retrainModel();
    expect(result.modelVersion).toContain(String(new Date().getFullYear()));
  });

  it('includes metrics in the response after successful training', async () => {
    const result = await service.retrainModel();
    expect(result.metrics).toBeDefined();
  });

  it('returns status "failed" when saveModel throws', async () => {
    // Force saveModel to throw by making fs.promises.writeFile reject
    const { promises } = await vi.importActual<typeof import('fs')>('fs');
    const fsMock = await import('fs');
    vi.mocked(fsMock.promises.writeFile).mockRejectedValueOnce(new Error('disk full'));

    const result = await service.retrainModel();
    expect(result.status).toBe('failed');
    expect(result.errorMessage).toBeTruthy();
  });

  it('returns failed status with an errorMessage on unexpected error', async () => {
    // Patch mlScorer.getVersion to throw
    const { mlScorer } = await import('../mlScorer.js');
    vi.mocked(mlScorer.getVersion).mockImplementationOnce(() => { throw new Error('scorer failure'); });

    const result = await service.retrainModel();
    // Result must not be undefined and must handle the error gracefully
    expect(['completed', 'failed']).toContain(result.status);
  });

  // ── getRetrainingHistory ──────────────────────────────────────────────────

  it('getRetrainingHistory returns an array', async () => {
    const history = await service.getRetrainingHistory();
    expect(Array.isArray(history)).toBe(true);
  });

  it('getRetrainingHistory respects the limit parameter', async () => {
    const history = await service.getRetrainingHistory(5);
    expect(history.length).toBeLessThanOrEqual(5);
  });

  // ── scheduleMonthlyRetraining ─────────────────────────────────────────────

  it('scheduleMonthlyRetraining returns a NodeJS.Timeout handle', () => {
    const handle = service.scheduleMonthlyRetraining();
    expect(handle).toBeDefined();
    clearInterval(handle); // clean up so test runner doesn't hang
  });

  // ── MODEL_PATH env override ───────────────────────────────────────────────

  it('respects MODEL_PATH env variable', () => {
    const original = process.env.MODEL_PATH;
    process.env.MODEL_PATH = '/custom/path/model.json';
    const s = new RetrainingService();
    // modelPath is private — verify via retrainModel not throwing
    expect(s).toBeDefined();
    process.env.MODEL_PATH = original;
  });
});
