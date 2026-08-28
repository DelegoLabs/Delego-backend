/**
 * Unit tests for #33 — transitionWorkflow writes the workflow state and its
 * service_event_outbox row inside a single DB transaction instead of persisting
 * the state and then calling redis.publish() directly.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

const { mockQuery, mockClientQuery, mockConnect, mockRelease } = vi.hoisted(() => {
  return {
    mockQuery: vi.fn(),
    mockClientQuery: vi.fn(),
    mockConnect: vi.fn(),
    mockRelease: vi.fn(),
  };
});

vi.mock("pg", () => {
  return {
    Pool: vi.fn().mockImplementation(() => ({
      query: mockQuery,
      connect: mockConnect,
    })),
  };
});

import { createWorkflow, transitionWorkflow } from "./index.js";

describe("transitionWorkflow transactional outbox write (Issue #33)", () => {
  beforeEach(() => {
    mockQuery.mockReset();
    mockClientQuery.mockReset();
    mockConnect.mockReset();
    mockRelease.mockReset();

    mockConnect.mockResolvedValue({
      query: mockClientQuery,
      release: mockRelease,
    });
  });

  it("writes the new state and enqueues an outbox row in one transaction (BEGIN/COMMIT)", async () => {
    // loadWorkflow() SELECT via the pool (not the transactional client)
    mockQuery.mockResolvedValueOnce({
      rows: [
        {
          order_id: "ord-1",
          state: "INITIATED",
          context: { orderId: "ord-1", userId: "usr-1", delegationId: "del-1", query: "q", products: [], selectedProductId: null, escrowId: null, escrowTxHash: null, merchantOrderId: null, settlementTxHash: null, error: null, createdAt: new Date() },
          updated_at: new Date(),
        },
      ],
    });

    // Transaction steps on the checked-out client: BEGIN, persistWorkflow, outbox insert, COMMIT
    mockClientQuery
      .mockResolvedValueOnce(undefined) // BEGIN
      .mockResolvedValueOnce(undefined) // persistWorkflow UPSERT
      .mockResolvedValueOnce(undefined) // outbox INSERT
      .mockResolvedValueOnce(undefined); // COMMIT

    const result = await transitionWorkflow("ord-1", { type: "SEARCH", query: "laptop", delegationId: "del-1" });

    expect(result.state).toBe("SEARCHING");
    expect(mockConnect).toHaveBeenCalledTimes(1);
    expect(mockClientQuery).toHaveBeenNthCalledWith(1, "BEGIN");

    const upsertCall = mockClientQuery.mock.calls[1];
    expect(upsertCall[0]).toMatch(/INSERT INTO purchase_workflows/);

    const outboxCall = mockClientQuery.mock.calls[2];
    expect(outboxCall[0]).toMatch(/INSERT INTO service_event_outbox/);
    expect(outboxCall[1][0]).toBe("workflow:state_changed");
    const payload = JSON.parse(outboxCall[1][1]);
    expect(payload).toMatchObject({
      orderId: "ord-1",
      previousState: "INITIATED",
      currentState: "SEARCHING",
      event: "SEARCH",
    });

    expect(mockClientQuery).toHaveBeenNthCalledWith(4, "COMMIT");
    expect(mockRelease).toHaveBeenCalledTimes(1);
  });

  it("rolls back and releases the client, and never writes the outbox row, when persistWorkflow fails", async () => {
    mockQuery.mockResolvedValueOnce({
      rows: [
        {
          order_id: "ord-2",
          state: "INITIATED",
          context: { orderId: "ord-2", userId: "usr-1", delegationId: "del-1", query: "q", products: [], selectedProductId: null, escrowId: null, escrowTxHash: null, merchantOrderId: null, settlementTxHash: null, error: null, createdAt: new Date() },
          updated_at: new Date(),
        },
      ],
    });

    mockClientQuery
      .mockResolvedValueOnce(undefined) // BEGIN
      .mockRejectedValueOnce(new Error("connection reset")) // persistWorkflow fails
      .mockResolvedValueOnce(undefined); // ROLLBACK

    await expect(
      transitionWorkflow("ord-2", { type: "SEARCH", query: "laptop", delegationId: "del-1" })
    ).rejects.toThrow("connection reset");

    const outboxInsertAttempted = mockClientQuery.mock.calls.some((call) =>
      typeof call[0] === "string" && call[0].includes("service_event_outbox")
    );
    expect(outboxInsertAttempted).toBe(false);

    const rollbackCalled = mockClientQuery.mock.calls.some((call) => call[0] === "ROLLBACK");
    expect(rollbackCalled).toBe(true);
    expect(mockRelease).toHaveBeenCalledTimes(1);
  });

  it("throws when the workflow does not exist, without opening a transaction", async () => {
    mockQuery.mockResolvedValueOnce({ rows: [] });

    await expect(
      transitionWorkflow("missing-order", { type: "SEARCH", query: "q", delegationId: "d" })
    ).rejects.toThrow("Workflow not found: missing-order");

    expect(mockConnect).not.toHaveBeenCalled();
  });
});

describe("createWorkflow", () => {
  beforeEach(() => {
    mockQuery.mockReset();
    mockConnect.mockReset();
  });

  it("persists the initial workflow row via the pool (no transaction needed — nothing to publish yet)", async () => {
    mockQuery.mockResolvedValueOnce({ rows: [] });

    const orderId = await createWorkflow("usr-1", "del-1", "laptop");

    expect(typeof orderId).toBe("string");
    expect(mockQuery).toHaveBeenCalledTimes(1);
    expect(mockQuery.mock.calls[0][0]).toMatch(/INSERT INTO purchase_workflows/);
  });
});
