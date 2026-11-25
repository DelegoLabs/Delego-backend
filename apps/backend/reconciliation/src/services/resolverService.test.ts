import { beforeEach, describe, expect, it, vi } from "vitest";
import { Op } from "sequelize";

vi.mock("../db.js", () => ({
  sequelize: { literal: vi.fn((value: string) => value) },
}));
vi.mock("../models/ReconciliationRecord.js", () => ({
  ReconciliationRecord: {
    findAll: vi.fn().mockResolvedValue([]),
    findByPk: vi.fn().mockResolvedValue(null),
    count: vi.fn().mockResolvedValue(0),
  },
}));
vi.mock("../models/ReconciliationJob.js", () => ({
  ReconciliationJob: { findByPk: vi.fn().mockResolvedValue(null) },
}));
vi.mock("../models/AuditLog.js", () => ({
  AuditLog: { create: vi.fn().mockResolvedValue({}) },
}));

import { AuditLog } from "../models/AuditLog.js";
import { ReconciliationJob } from "../models/ReconciliationJob.js";
import { ReconciliationRecord } from "../models/ReconciliationRecord.js";
import { ResolverService } from "./resolverService.js";

type FakeRecord = {
  id: string;
  jobId: string;
  discrepancyType?: string;
  discrepancyAmount?: string;
  resolution?: string;
  update: ReturnType<typeof vi.fn>;
};

function fakeRecord(overrides: Partial<FakeRecord> = {}): FakeRecord {
  return {
    id: "rec-1",
    jobId: "job-1",
    discrepancyType: "amount",
    discrepancyAmount: "5",
    resolution: undefined,
    update: vi.fn().mockResolvedValue({}),
    ...overrides,
  };
}

function fakeJob(discrepancies = 2) {
  return { discrepancies, update: vi.fn().mockResolvedValue({}) };
}

describe("ResolverService", () => {
  const service = new ResolverService();

  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(ReconciliationRecord.findAll).mockResolvedValue([] as never);
    vi.mocked(ReconciliationRecord.findByPk).mockResolvedValue(null as never);
    vi.mocked(ReconciliationRecord.count).mockResolvedValue(0);
    vi.mocked(ReconciliationJob.findByPk).mockResolvedValue(null as never);
    vi.mocked(AuditLog.create).mockResolvedValue({} as never);
  });

  it("auto-resolves rounding differences and decrements the job count", async () => {
    const record = fakeRecord({ discrepancyAmount: "0.005" });
    vi.mocked(ReconciliationRecord.findAll).mockResolvedValue([record] as never);
    vi.mocked(ReconciliationJob.findByPk).mockResolvedValue(fakeJob(2) as never);

    const result = await service.autoResolveDiscrepancies("job-1");

    expect(result).toEqual({ resolved: 1, patterns: { auto_resolved: 1 } });
    expect(ReconciliationRecord.findAll).toHaveBeenCalledWith({
      where: { status: "discrepancy", resolution: { [Op.is]: null }, jobId: "job-1" },
    });
    expect(record.update).toHaveBeenCalledWith({
      resolution: "auto_resolved",
      resolvedAt: expect.any(Date),
      resolvedBy: "system",
    });
    expect(AuditLog.create).toHaveBeenCalledWith(
      expect.objectContaining({
        recordId: "rec-1",
        action: "discrepancy_resolved",
        details: expect.objectContaining({
          newResolution: "auto_resolved",
          resolvedBy: "system",
          notes: "Amount difference is within rounding tolerance",
        }),
      }),
    );
  });

  it.each([
    ["date", "Date difference within acceptable timing window"],
    ["fee", "Fee variance within acceptable range"],
    ["reference", "Reference mismatch likely due to duplicate processing"],
  ])("auto-resolves %s discrepancies with the expected note", async (type, note) => {
    const record = fakeRecord({ discrepancyType: type, discrepancyAmount: "5" });
    vi.mocked(ReconciliationRecord.findAll).mockResolvedValue([record] as never);

    const result = await service.autoResolveDiscrepancies();

    expect(result.patterns.auto_resolved).toBe(1);
    expect(AuditLog.create).toHaveBeenCalledWith(
      expect.objectContaining({ details: expect.objectContaining({ notes: note }) }),
    );
  });

  it("leaves unknown discrepancy patterns unresolved", async () => {
    const record = fakeRecord({ discrepancyType: "missing", discrepancyAmount: "5" });
    vi.mocked(ReconciliationRecord.findAll).mockResolvedValue([record] as never);

    expect(await service.autoResolveDiscrepancies()).toEqual({ resolved: 0, patterns: {} });
    expect(record.update).not.toHaveBeenCalled();
    expect(AuditLog.create).not.toHaveBeenCalled();
  });

  it("manually resolves a record, writes an audit entry, and decrements the job", async () => {
    const record = fakeRecord({ resolution: "investigating" });
    const job = fakeJob(3);
    vi.mocked(ReconciliationRecord.findByPk).mockResolvedValue(record as never);
    vi.mocked(ReconciliationJob.findByPk).mockResolvedValue(job as never);

    const result = await service.resolveDiscrepancy(
      "rec-1",
      "manual_resolved",
      "checked with bank",
      "alice",
    );

    expect(result).toBe(record);
    expect(record.update).toHaveBeenCalledWith({
      resolution: "manual_resolved",
      resolvedAt: expect.any(Date),
      resolvedBy: "alice",
    });
    expect(AuditLog.create).toHaveBeenCalledWith(
      expect.objectContaining({
        details: expect.objectContaining({
          oldResolution: "investigating",
          newResolution: "manual_resolved",
          notes: "checked with bank",
          resolvedBy: "alice",
        }),
      }),
    );
    expect(job.update).toHaveBeenCalledWith({ discrepancies: 2 });
  });

  it("does not decrement the job when marking a record as investigating", async () => {
    const record = fakeRecord();
    const job = fakeJob(2);
    vi.mocked(ReconciliationRecord.findByPk).mockResolvedValue(record as never);
    vi.mocked(ReconciliationJob.findByPk).mockResolvedValue(job as never);

    await service.resolveDiscrepancy("rec-1", "investigating", "awaiting evidence", "alice");

    expect(record.update).toHaveBeenCalled();
    expect(AuditLog.create).toHaveBeenCalled();
    expect(job.update).not.toHaveBeenCalled();
  });

  it("writes off a discrepancy with the supplied reason", async () => {
    const record = fakeRecord();
    vi.mocked(ReconciliationRecord.findByPk).mockResolvedValue(record as never);

    await service.writeOffDiscrepancy("rec-1", "fraud confirmed", "bob");

    expect(record.update).toHaveBeenCalledWith(
      expect.objectContaining({ resolution: "write_off", resolvedBy: "bob" }),
    );
    expect(AuditLog.create).toHaveBeenCalledWith(
      expect.objectContaining({ details: expect.objectContaining({ notes: "fraud confirmed" }) }),
    );
  });

  it("returns null when the record does not exist", async () => {
    vi.mocked(ReconciliationRecord.findByPk).mockResolvedValue(null as never);

    expect(await service.resolveDiscrepancy("missing", "manual_resolved")).toBeNull();
    expect(AuditLog.create).not.toHaveBeenCalled();
  });

  it("floors the job discrepancy count at zero", async () => {
    const record = fakeRecord();
    const job = fakeJob(0);
    vi.mocked(ReconciliationRecord.findByPk).mockResolvedValue(record as never);
    vi.mocked(ReconciliationJob.findByPk).mockResolvedValue(job as never);

    await service.resolveDiscrepancy("rec-1", "manual_resolved");

    expect(job.update).toHaveBeenCalledWith({ discrepancies: 0 });
  });

  it("lists unresolved discrepancies with pagination and filters", async () => {
    vi.mocked(ReconciliationRecord.count).mockResolvedValue(12);

    const result = await service.getRecordsForResolution({ type: "fee", page: 2, pageSize: 10 });

    expect(result.total).toBe(12);
    expect(ReconciliationRecord.findAll).toHaveBeenCalledWith({
      where: {
        status: "discrepancy",
        resolution: { [Op.is]: "NULL" },
        discrepancyType: "fee",
      },
      limit: 10,
      offset: 10,
    });
  });

  it("computes auto-resolution statistics including the zero-total case", async () => {
    vi.mocked(ReconciliationRecord.count).mockResolvedValueOnce(10).mockResolvedValueOnce(4);
    expect(await service.getAutoResolutionStats()).toEqual({
      totalDiscrepancies: 10,
      autoResolved: 4,
      autoResolutionRate: 0.4,
    });

    vi.mocked(ReconciliationRecord.count).mockReset().mockResolvedValue(0);
    expect((await service.getAutoResolutionStats()).autoResolutionRate).toBe(0);
  });

  it("groups resolved patterns by type and sums discrepancy amounts", async () => {
    vi.mocked(ReconciliationRecord.findAll).mockResolvedValue([
      fakeRecord({ discrepancyType: "fee", discrepancyAmount: "1.5" }),
      fakeRecord({ id: "rec-2", discrepancyType: "fee", discrepancyAmount: "2.5" }),
      fakeRecord({ id: "rec-3", discrepancyType: undefined, discrepancyAmount: undefined }),
    ] as never);

    expect(await service.getPatternStats()).toEqual({
      fee: { count: 2, totalAmount: 4 },
      unknown: { count: 1, totalAmount: 0 },
    });
  });
});
