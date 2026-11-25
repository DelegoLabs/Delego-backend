import { afterEach, describe, expect, it, vi } from "vitest";
import { Op } from "sequelize";

vi.mock("./db.js", () => ({
  sequelize: { literal: vi.fn((value: string) => ({ literal: value })) },
}));

vi.mock("./models/ReconciliationJob.js", () => ({
  ReconciliationJob: { findAll: vi.fn() },
}));

vi.mock("./models/ReconciliationRecord.js", () => ({
  ReconciliationRecord: { findAll: vi.fn(), count: vi.fn() },
}));

vi.mock("./models/ReconciliationReport.js", () => ({
  ReconciliationReport: { findOne: vi.fn() },
}));

import { ReconciliationJob } from "./models/ReconciliationJob.js";
import { ReconciliationRecord } from "./models/ReconciliationRecord.js";
import { ReconciliationReport } from "./models/ReconciliationReport.js";
import { reportingService } from "./reportingService.js";
import { ReportingService } from "./services/reportingService.js";

const jobFindAll = vi.mocked(ReconciliationJob.findAll);
const recordFindAll = vi.mocked(ReconciliationRecord.findAll);
const recordCount = vi.mocked(ReconciliationRecord.count);
const reportFindOne = vi.mocked(ReconciliationReport.findOne);

function jobs(list: Array<Record<string, unknown>>) {
  jobFindAll.mockResolvedValue(list as never);
}

function records(list: Array<Record<string, unknown>>) {
  recordFindAll.mockResolvedValue(list as never);
}

function job(overrides: Record<string, unknown> = {}) {
  return {
    id: "job-1",
    status: "completed",
    matchedRecords: 0,
    discrepancies: 0,
    totalRecords: 0,
    startedAt: new Date("2026-11-01T10:00:00.000Z"),
    ...overrides,
  };
}

const unresolvedWhere = {
  status: "discrepancy",
  resolution: { [Op.is]: { literal: "NULL" } },
};

afterEach(() => {
  vi.clearAllMocks();
  vi.useRealTimers();
});

describe("reportingService export", () => {
  it("re-exports the shared ReportingService instance", () => {
    expect(reportingService).toBeInstanceOf(ReportingService);
  });
});

describe("getReport", () => {
  it("looks the report up by job id", async () => {
    const report = { id: "report-1", jobId: "job-1" };
    reportFindOne.mockResolvedValue(report as never);

    await expect(reportingService.getReport("job-1")).resolves.toBe(report);
    expect(reportFindOne).toHaveBeenCalledWith({ where: { jobId: "job-1" } });
  });
});

describe("getSummary", () => {
  it("aggregates job counts, matched records and the match rate", async () => {
    jobs([
      job({ id: "a", status: "completed", matchedRecords: 8, discrepancies: 2, totalRecords: 10 }),
      job({ id: "b", status: "partial", matchedRecords: 5, discrepancies: 5, totalRecords: 10 }),
      job({ id: "c", status: "pending", matchedRecords: 0, discrepancies: 0, totalRecords: 0 }),
      job({ id: "d", status: "failed", matchedRecords: 2, discrepancies: 3, totalRecords: 20 }),
      job({ id: "e", status: "running", matchedRecords: 1, discrepancies: 0, totalRecords: 0 }),
    ]);

    await expect(reportingService.getSummary()).resolves.toEqual({
      totalJobs: 5,
      completedJobs: 2,
      pendingJobs: 1,
      failedJobs: 1,
      totalMatched: 16,
      totalDiscrepancies: 10,
      averageMatchRate: 16 / 40,
      lastRun: "2026-11-01T10:00:00.000Z",
    });
  });

  it("returns zeros and the current time when there are no jobs", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-11-24T12:00:00.000Z"));
    jobs([]);

    await expect(reportingService.getSummary()).resolves.toEqual({
      totalJobs: 0,
      completedJobs: 0,
      pendingJobs: 0,
      failedJobs: 0,
      totalMatched: 0,
      totalDiscrepancies: 0,
      averageMatchRate: 0,
      lastRun: "2026-11-24T12:00:00.000Z",
    });
  });
});

describe("getRecordsWithReport", () => {
  it("returns the job's records together with its report", async () => {
    const jobRecords = [{ id: "r1" }, { id: "r2" }];
    const report = { id: "report-1" };
    records(jobRecords);
    reportFindOne.mockResolvedValue(report as never);

    await expect(reportingService.getRecordsWithReport("job-1")).resolves.toEqual({
      records: jobRecords,
      report,
    });
    expect(recordFindAll).toHaveBeenCalledWith({ where: { jobId: "job-1" } });
    expect(reportFindOne).toHaveBeenCalledWith({ where: { jobId: "job-1" } });
  });
});

describe("getUnresolvedDiscrepancies", () => {
  it("returns the first page of unresolved discrepancies with the total count", async () => {
    const rows = [{ id: "r1" }];
    records(rows);
    recordCount.mockResolvedValue(7 as never);

    await expect(reportingService.getUnresolvedDiscrepancies()).resolves.toEqual({
      discrepancies: rows,
      total: 7,
    });
    expect(recordFindAll).toHaveBeenCalledWith({
      where: unresolvedWhere,
      limit: 50,
      offset: 0,
      include: [{ model: ReconciliationJob }],
    });
    expect(recordCount).toHaveBeenCalledWith({ where: unresolvedWhere });
  });

  it("applies the requested page and page size", async () => {
    records([]);
    recordCount.mockResolvedValue(0 as never);

    await reportingService.getUnresolvedDiscrepancies({ page: 3, pageSize: 10 });

    expect(recordFindAll).toHaveBeenCalledWith(expect.objectContaining({ limit: 10, offset: 20 }));
  });
});

describe("getDiscrepanciesByType", () => {
  it("groups discrepancies by type, sums amounts and sorts by count", async () => {
    records([
      { discrepancyType: "amount", discrepancyAmount: "10.50" },
      { discrepancyType: "fee", discrepancyAmount: "1.25" },
      { discrepancyType: "amount", discrepancyAmount: "4.5" },
      { discrepancyType: "amount" },
      { discrepancyAmount: "2" },
    ]);

    await expect(reportingService.getDiscrepanciesByType()).resolves.toEqual([
      { type: "amount", count: 3, totalAmount: "15.00" },
      { type: "fee", count: 1, totalAmount: "1.25" },
      { type: "unknown", count: 1, totalAmount: "2.00" },
    ]);
    expect(recordFindAll).toHaveBeenCalledWith({ where: { status: "discrepancy" } });
  });

  it("returns an empty list when there are no discrepancies", async () => {
    records([]);

    await expect(reportingService.getDiscrepanciesByType()).resolves.toEqual([]);
  });
});

describe("getCurrencyBreakdown", () => {
  it("counts records and sums internal amounts per currency for a job", async () => {
    records([
      { currency: "USD", internalAmount: "10.10" },
      { currency: "EUR", internalAmount: "5" },
      { currency: "USD", internalAmount: "0.20" },
    ]);

    await expect(reportingService.getCurrencyBreakdown("job-1")).resolves.toEqual({
      USD: { count: 2, amount: "10.30" },
      EUR: { count: 1, amount: "5.00" },
    });
    expect(recordFindAll).toHaveBeenCalledWith({
      where: { jobId: "job-1" },
      attributes: ["currency", "internalAmount", "status"],
    });
  });

  it("covers every record when no job id is given", async () => {
    records([]);

    await expect(reportingService.getCurrencyBreakdown()).resolves.toEqual({});
    expect(recordFindAll).toHaveBeenCalledWith(expect.objectContaining({ where: {} }));
  });
});

describe("getTopDiscrepancies", () => {
  it("lists the most frequent discrepancy types with their distinct jobs", async () => {
    records([
      { discrepancyType: "amount", jobId: "job-1", discrepancyAmount: "3" },
      { discrepancyType: "amount", jobId: "job-1", discrepancyAmount: "2" },
      { discrepancyType: "amount", jobId: "job-2" },
      { discrepancyType: "date", jobId: "job-2", discrepancyAmount: "1" },
      { discrepancyType: "date", jobId: "job-3" },
      { discrepancyType: "fee", jobId: "job-3", discrepancyAmount: "0.5" },
    ]);

    await expect(reportingService.getTopDiscrepancies(2)).resolves.toEqual([
      { type: "amount", count: 3, totalAmount: "5.00", jobs: ["job-1", "job-2"] },
      { type: "date", count: 2, totalAmount: "1.00", jobs: ["job-2", "job-3"] },
    ]);
    expect(recordFindAll).toHaveBeenCalledWith({
      where: { status: "discrepancy" },
      attributes: ["discrepancyType", "jobId", "discrepancyAmount"],
    });
  });

  it("returns at most ten types by default", async () => {
    records(
      Array.from({ length: 12 }, (_, i) => ({ discrepancyType: `type-${i}`, jobId: "job-1" })),
    );

    await expect(reportingService.getTopDiscrepancies()).resolves.toHaveLength(10);
  });
});

describe("generateAuditReport", () => {
  it("collects jobs in the date range and computes the match rate of their records", async () => {
    const rangeJobs = [job({ id: "job-1" }), job({ id: "job-2" })];
    const jobRecords = [
      { id: "r1", status: "matched" },
      { id: "r2", status: "matched" },
      { id: "r3", status: "discrepancy" },
      { id: "r4", status: "unmatched_internal" },
    ];
    jobs(rangeJobs);
    records(jobRecords);

    const report = await reportingService.generateAuditReport("2026-11-01", "2026-11-30");

    expect(report).toEqual({ jobs: rangeJobs, records: jobRecords, discrepancies: 1, matchRate: 0.5 });
    expect(jobFindAll).toHaveBeenCalledWith({
      where: {
        startedAt: {
          [Op.gte]: new Date("2026-11-01"),
          [Op.lte]: new Date("2026-11-30"),
        },
      },
    });
    expect(recordFindAll).toHaveBeenCalledWith({ where: { jobId: ["job-1", "job-2"] } });
  });

  it("reports a zero match rate when the range has no records", async () => {
    jobs([]);
    records([]);

    await expect(reportingService.generateAuditReport("2026-01-01", "2026-01-31")).resolves.toEqual({
      jobs: [],
      records: [],
      discrepancies: 0,
      matchRate: 0,
    });
  });
});
