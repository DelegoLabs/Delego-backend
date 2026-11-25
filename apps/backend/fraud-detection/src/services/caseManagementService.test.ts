import { describe, it, expect, vi, beforeEach } from 'vitest';
import { CaseManagementService } from './caseManagementService.js';
import { FraudCase } from '../models/FraudCase.js';
import { FraudCheckResult } from '../models/FraudCheckResult.js';
import { FraudEventLog } from '../models/FraudEventLog.js';

vi.mock('../models/FraudCase.js');
vi.mock('../models/FraudCheckResult.js');
vi.mock('../models/FraudEventLog.js');
vi.mock('@delegolabs/utils', () => ({ createLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn() }) }));

function makeFraudCase(overrides: Partial<Record<string, unknown>> = {}) {
  const data = {
    id: 'case-1',
    transactionId: 'tx-1',
    status: 'open',
    priority: 'medium',
    assignedTo: null,
    evidence: [],
    resolution: null,
    update: vi.fn(),
    getDataValue: vi.fn((key: string) => {
      if (key === 'createdAt') return new Date('2026-01-01');
      if (key === 'updatedAt') return new Date('2026-01-02');
      return undefined;
    }),
    toJSON: vi.fn(() => ({})),
    ...overrides,
  };
  return data;
}

describe('CaseManagementService — case state transitions', () => {
  let service: CaseManagementService;

  beforeEach(() => {
    service = new CaseManagementService();
    vi.clearAllMocks();
  });

  // ── createCase ────────────────────────────────────────────────────────────

  it('creates a case with status "open" and priority "medium" by default', async () => {
    const fake = makeFraudCase();
    vi.mocked(FraudCase.create).mockResolvedValue(fake as any);
    vi.mocked(FraudCase.findByPk).mockResolvedValue(fake as any);
    vi.mocked(FraudCheckResult.findOne).mockResolvedValue(null);

    const result = await service.createCase({ transactionId: 'tx-1', priority: undefined as any, assignedTo: undefined });
    expect(FraudCase.create).toHaveBeenCalledWith(expect.objectContaining({ status: 'open', priority: 'medium' }));
    expect(result.id).toBe('case-1');
    expect(result.status).toBe('open');
  });

  it('creates a case with the supplied priority', async () => {
    const fake = makeFraudCase({ priority: 'high' });
    vi.mocked(FraudCase.create).mockResolvedValue(fake as any);
    vi.mocked(FraudCase.findByPk).mockResolvedValue(fake as any);
    vi.mocked(FraudCheckResult.findOne).mockResolvedValue(null);

    await service.createCase({ transactionId: 'tx-2', priority: 'high', assignedTo: undefined });
    expect(FraudCase.create).toHaveBeenCalledWith(expect.objectContaining({ priority: 'high' }));
  });

  // ── getCase ───────────────────────────────────────────────────────────────

  it('returns null when case is not found', async () => {
    vi.mocked(FraudCase.findByPk).mockResolvedValue(null);
    const result = await service.getCase('nonexistent');
    expect(result).toBeNull();
  });

  it('returns formatted case when found', async () => {
    const fake = makeFraudCase();
    vi.mocked(FraudCase.findByPk).mockResolvedValue(fake as any);
    const result = await service.getCase('case-1');
    expect(result?.id).toBe('case-1');
    expect(result?.transactionId).toBe('tx-1');
  });

  // ── updateCase / status transitions ───────────────────────────────────────

  it('transitions status from open → investigating', async () => {
    const fake = makeFraudCase();
    vi.mocked(FraudCase.findByPk).mockResolvedValue(fake as any);
    vi.mocked(FraudEventLog.create).mockResolvedValue({} as any);

    await service.updateCase('case-1', { status: 'investigating' });

    expect(fake.update).toHaveBeenCalledWith(expect.objectContaining({ status: 'investigating' }));
  });

  it('logs a status-change event when status is updated', async () => {
    const fake = makeFraudCase({ status: 'open' });
    vi.mocked(FraudCase.findByPk).mockResolvedValue(fake as any);
    vi.mocked(FraudEventLog.create).mockResolvedValue({} as any);

    await service.updateCase('case-1', { status: 'investigating' });

    expect(FraudEventLog.create).toHaveBeenCalledWith(
      expect.objectContaining({ eventType: 'case_status_changed' })
    );
  });

  it('returns null when updating a non-existent case', async () => {
    vi.mocked(FraudCase.findByPk).mockResolvedValue(null);
    const result = await service.updateCase('ghost', { status: 'closed' });
    expect(result).toBeNull();
  });

  // ── closeCase ─────────────────────────────────────────────────────────────

  it('sets status to confirmed_fraud when outcome is "fraud"', async () => {
    const fake = makeFraudCase();
    vi.mocked(FraudCase.findByPk).mockResolvedValue(fake as any);
    vi.mocked(FraudEventLog.create).mockResolvedValue({} as any);

    await service.closeCase('case-1', 'fraud', 'account_blocked', 'analyst-1');

    expect(fake.update).toHaveBeenCalledWith(
      expect.objectContaining({ status: 'confirmed_fraud' })
    );
  });

  it('sets status to false_positive when outcome is "legitimate"', async () => {
    const fake = makeFraudCase();
    vi.mocked(FraudCase.findByPk).mockResolvedValue(fake as any);
    vi.mocked(FraudEventLog.create).mockResolvedValue({} as any);

    await service.closeCase('case-1', 'legitimate', 'no_action', 'analyst-2');

    expect(fake.update).toHaveBeenCalledWith(
      expect.objectContaining({ status: 'false_positive' })
    );
  });

  it('records resolution metadata on close', async () => {
    const fake = makeFraudCase();
    vi.mocked(FraudCase.findByPk).mockResolvedValue(fake as any);
    vi.mocked(FraudEventLog.create).mockResolvedValue({} as any);

    await service.closeCase('case-1', 'fraud', 'blocked', 'analyst-3');

    const updateArg = (fake.update as ReturnType<typeof vi.fn>).mock.calls[0][0];
    expect(updateArg.resolution).toMatchObject({
      outcome: 'fraud',
      actionTaken: 'blocked',
      resolvedBy: 'analyst-3',
    });
  });

  // ── addEvidence ───────────────────────────────────────────────────────────

  it('appends evidence to the existing list', async () => {
    const fake = makeFraudCase({ evidence: [{ type: 'prior', data: {} }] });
    vi.mocked(FraudCase.findByPk).mockResolvedValue(fake as any);

    await service.addEvidence('case-1', { type: 'manual_review', data: { note: 'suspicious' }, addedBy: 'analyst' });

    const updateArg = (fake.update as ReturnType<typeof vi.fn>).mock.calls[0][0];
    expect(updateArg.evidence).toHaveLength(2);
  });

  // ── assignCase / changePriority ───────────────────────────────────────────

  it('assigns case to analyst', async () => {
    const fake = makeFraudCase();
    vi.mocked(FraudCase.findByPk).mockResolvedValue(fake as any);
    vi.mocked(FraudEventLog.create).mockResolvedValue({} as any);

    await service.assignCase('case-1', 'analyst-99');

    expect(fake.update).toHaveBeenCalledWith(expect.objectContaining({ assignedTo: 'analyst-99' }));
  });

  it('changes case priority', async () => {
    const fake = makeFraudCase();
    vi.mocked(FraudCase.findByPk).mockResolvedValue(fake as any);
    vi.mocked(FraudEventLog.create).mockResolvedValue({} as any);

    await service.changePriority('case-1', 'urgent');

    expect(fake.update).toHaveBeenCalledWith(expect.objectContaining({ priority: 'urgent' }));
  });

  // ── getPendingCasesCount ──────────────────────────────────────────────────

  it('counts only open and investigating cases', async () => {
    vi.mocked(FraudCase.findAll).mockResolvedValue([{} as any, {} as any, {} as any]);

    const count = await service.getPendingCasesCount();
    expect(count).toBe(3);
  });
});
