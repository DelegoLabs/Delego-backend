import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@delegolabs/utils", () => ({
  createLogger: () => ({ debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() }),
}));
vi.mock("../models/ReconciliationRecord.js", () => ({
  ReconciliationRecord: {
    build: vi.fn((attrs: Record<string, unknown>) => ({ ...attrs, get: () => attrs })),
    bulkCreate: vi.fn().mockResolvedValue([]),
    findAll: vi.fn().mockResolvedValue([]),
  },
}));

import { ReconciliationRecord } from "../models/ReconciliationRecord.js";
import { MatcherService } from "./matcherService.js";

type InputRecord = {
  id?: string;
  amount: string;
  currency: string;
  date: string;
  reference: string;
  type: string;
  metadata?: Record<string, unknown>;
};

function record(overrides: Partial<InputRecord> = {}): InputRecord {
  return {
    id: "int-1",
    amount: "100",
    currency: "USD",
    date: "2026-11-23",
    reference: "pay-1",
    type: "payment",
    ...overrides,
  };
}

function persisted() {
  const bulkCreate = vi.mocked(ReconciliationRecord.bulkCreate);
  expect(bulkCreate).toHaveBeenCalledTimes(1);
  return bulkCreate.mock.calls[0][0] as Array<Record<string, unknown>>;
}

describe("MatcherService", () => {
  const service = new MatcherService();

  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(ReconciliationRecord.bulkCreate).mockResolvedValue([] as never);
    vi.mocked(ReconciliationRecord.findAll).mockResolvedValue([] as never);
  });

  it("matches exact records without a discrepancy", async () => {
    const result = await service.matchRecords("job-1", [record()], [record({ id: "ext-1" })]);

    expect(result).toEqual({ matched: 1, discrepancies: 0, unmatchedInternal: 0, unmatchedExternal: 0 });
    expect(persisted()).toEqual([
      expect.objectContaining({
        jobId: "job-1",
        internalRecordId: "int-1",
        externalRecordId: "ext-1",
        status: "matched",
        internalAmount: "100",
        externalAmount: "100",
        currency: "USD",
      }),
    ]);
    expect(persisted()[0].discrepancyType).toBeUndefined();
    expect(persisted()[0].discrepancyAmount).toBeUndefined();
  });

  it("keeps amount differences within the one-cent tolerance as matched", async () => {
    const result = await service.matchRecords(
      "job-1",
      [record()],
      [record({ id: "ext-1", amount: "100.0078125" })],
    );

    expect(result).toEqual({ matched: 1, discrepancies: 0, unmatchedInternal: 0, unmatchedExternal: 0 });
    expect(persisted()[0]).toMatchObject({ status: "matched", externalAmount: "100.0078125" });
  });

  it("records an amount discrepancy just outside the tolerance", async () => {
    const result = await service.matchRecords(
      "job-1",
      [record()],
      [record({ id: "ext-1", amount: "100.015625" })],
    );

    expect(result).toEqual({ matched: 0, discrepancies: 1, unmatchedInternal: 0, unmatchedExternal: 0 });
    expect(persisted()[0]).toMatchObject({
      status: "discrepancy",
      discrepancyType: "amount",
      discrepancyAmount: "0.015625",
    });
  });

  it("fuzzy-matches records whose reference differs", async () => {
    const result = await service.matchRecords(
      "job-1",
      [record()],
      [record({ id: "ext-1", reference: "pay-2" })],
    );

    expect(result.matched).toBe(1);
    expect(result.discrepancies).toBe(0);
    expect(persisted()[0]).toMatchObject({ status: "matched", externalRecordId: "ext-1" });
  });

  it("reports cross-currency (FX) differences as raw amount discrepancies", async () => {
    const result = await service.matchRecords(
      "job-1",
      [record({ currency: "XLM", amount: "100" })],
      [record({ id: "ext-1", currency: "USD", amount: "8" })],
    );

    expect(result.discrepancies).toBe(1);
    expect(persisted()[0]).toMatchObject({
      status: "discrepancy",
      currency: "XLM",
      discrepancyType: "amount",
      discrepancyAmount: "92",
    });
  });

  it("persists unmatched internal and external records", async () => {
    const result = await service.matchRecords(
      "job-1",
      [record()],
      [record({ id: "ext-1", currency: "EUR", date: "2026-11-24", type: "refund", reference: "pay-2" })],
    );

    expect(result).toEqual({ matched: 0, discrepancies: 0, unmatchedInternal: 1, unmatchedExternal: 1 });
    expect(persisted()).toEqual([
      expect.objectContaining({ status: "unmatched_internal", internalRecordId: "int-1" }),
      expect.objectContaining({ status: "unmatched_external", externalRecordId: "ext-1" }),
    ]);
  });

  it("propagates persistence failures", async () => {
    vi.mocked(ReconciliationRecord.bulkCreate).mockRejectedValueOnce(new Error("db down"));

    await expect(service.matchRecords("job-1", [record()], [record({ id: "ext-1" })])).rejects.toThrow(
      "db down",
    );
  });

  it("queries records by job and status", async () => {
    await service.getRecordsByJob("job-1");
    expect(ReconciliationRecord.findAll).toHaveBeenCalledWith({ where: { jobId: "job-1" } });

    await service.getRecordsByStatus("discrepancy", 5);
    expect(ReconciliationRecord.findAll).toHaveBeenCalledWith({
      where: { status: "discrepancy" },
      limit: 5,
    });
  });
});
