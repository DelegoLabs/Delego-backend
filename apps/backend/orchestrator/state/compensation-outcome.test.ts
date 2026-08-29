/**
 * Unit tests for #35 — compensation outcome persistence on the workflow record.
 */
import { describe, it, expect, beforeEach } from "vitest";
import {
  upsertCompensationOutcome,
  getCompensationOutcome,
  resetCompensationOutcomeStore,
} from "./compensation-outcome.js";

describe("upsertCompensationOutcome / getCompensationOutcome", () => {
  beforeEach(() => {
    resetCompensationOutcomeStore();
  });

  it("throws when workflowId is empty", async () => {
    await expect(
      upsertCompensationOutcome({
        workflowId: "  ",
        status: "success",
        compensatedSteps: [],
        failedSteps: [],
        cause: null,
      })
    ).rejects.toThrow("workflowId is required");
  });

  it("creates a new record with attempts=1 on first upsert", async () => {
    const record = await upsertCompensationOutcome({
      workflowId: "wf-1",
      status: "success",
      compensatedSteps: ["fundEscrow"],
      failedSteps: [],
      cause: "saga failed",
    });

    expect(record.attempts).toBe(1);
    expect(record.status).toBe("success");
    expect(record.compensatedSteps).toEqual(["fundEscrow"]);
  });

  it("increments attempts and overwrites status on a repeated upsert for the same workflowId", async () => {
    await upsertCompensationOutcome({
      workflowId: "wf-1",
      status: "partial_failure",
      compensatedSteps: [],
      failedSteps: [{ step: "fundEscrow", error: "timeout" }],
      cause: "saga failed",
    });

    const second = await upsertCompensationOutcome({
      workflowId: "wf-1",
      status: "success",
      compensatedSteps: ["fundEscrow"],
      failedSteps: [],
      cause: "saga failed",
    });

    expect(second.attempts).toBe(2);
    expect(second.status).toBe("success");
    expect(second.failedSteps).toEqual([]);
  });

  it("preserves createdAt across repeated upserts but advances updatedAt", async () => {
    const first = await upsertCompensationOutcome({
      workflowId: "wf-1",
      status: "partial_failure",
      compensatedSteps: [],
      failedSteps: [],
      cause: null,
    });

    const second = await upsertCompensationOutcome({
      workflowId: "wf-1",
      status: "escrow_stuck",
      compensatedSteps: [],
      failedSteps: [],
      cause: null,
    });

    expect(second.createdAt).toBe(first.createdAt);
  });

  it("supports the escrow_stuck status value", async () => {
    const record = await upsertCompensationOutcome({
      workflowId: "wf-stuck",
      status: "escrow_stuck",
      compensatedSteps: [],
      failedSteps: [{ step: "fundEscrow", error: "Soroban RPC down" }],
      cause: "settlement failed",
    });

    expect(record.status).toBe("escrow_stuck");
  });

  it("getCompensationOutcome returns null for an unknown workflowId", async () => {
    const record = await getCompensationOutcome("does-not-exist");
    expect(record).toBeNull();
  });

  it("getCompensationOutcome returns the latest upserted record", async () => {
    await upsertCompensationOutcome({
      workflowId: "wf-2",
      status: "success",
      compensatedSteps: ["a", "b"],
      failedSteps: [],
      cause: null,
    });

    const record = await getCompensationOutcome("wf-2");
    expect(record?.compensatedSteps).toEqual(["a", "b"]);
  });

  it("keeps records for different workflowIds independent", async () => {
    await upsertCompensationOutcome({
      workflowId: "wf-a",
      status: "success",
      compensatedSteps: [],
      failedSteps: [],
      cause: null,
    });
    await upsertCompensationOutcome({
      workflowId: "wf-b",
      status: "escrow_stuck",
      compensatedSteps: [],
      failedSteps: [],
      cause: null,
    });

    expect((await getCompensationOutcome("wf-a"))?.status).toBe("success");
    expect((await getCompensationOutcome("wf-b"))?.status).toBe("escrow_stuck");
  });
});
