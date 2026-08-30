import { describe, it, expect, beforeEach } from "vitest";
import {
  checkAndMarkProcessed,
  resetProcessedMessageStore,
  PostgresProcessedMessageStore,
} from "./processed-messages.js";

describe("checkAndMarkProcessed", () => {
  beforeEach(() => {
    resetProcessedMessageStore();
  });

  it("returns true on first message claim", async () => {
    const first = await checkAndMarkProcessed("msg-1", "notifications-worker");
    expect(first).toBe(true);
  });

  it("returns false on duplicate message id", async () => {
    await checkAndMarkProcessed("msg-dup", "payments-worker");
    const duplicate = await checkAndMarkProcessed("msg-dup", "payments-worker");
    expect(duplicate).toBe(false);
  });

  it("rejects empty message id", async () => {
    await expect(checkAndMarkProcessed("", "worker")).rejects.toThrow(
      "messageId is required"
    );
  });

  it("rejects empty consumer", async () => {
    await expect(checkAndMarkProcessed("msg-2", "")).rejects.toThrow(
      "consumer is required"
    );
  });
});

describe("PostgresProcessedMessageStore (#36)", () => {
  function mockPool(rowCount: number) {
    return {
      query: async () => ({ rowCount, rows: rowCount > 0 ? [{ message_id: "msg-1" }] : [] }),
    } as unknown as import("pg").Pool;
  }

  it("returns true when the INSERT ... ON CONFLICT claims the row", async () => {
    const store = new PostgresProcessedMessageStore(mockPool(1));
    await expect(store.checkAndMark("msg-1", "worker")).resolves.toBe(true);
  });

  it("returns false when ON CONFLICT DO NOTHING skips a duplicate", async () => {
    const store = new PostgresProcessedMessageStore(mockPool(0));
    await expect(store.checkAndMark("msg-1", "worker")).resolves.toBe(false);
  });

  it("issues a single parameterized query with the message id and consumer", async () => {
    let capturedSql = "";
    let capturedParams: unknown[] = [];
    const pool = {
      query: async (sql: string, params: unknown[]) => {
        capturedSql = sql;
        capturedParams = params;
        return { rowCount: 1, rows: [{ message_id: "msg-7" }] };
      },
    } as unknown as import("pg").Pool;

    const store = new PostgresProcessedMessageStore(pool);
    await store.checkAndMark("msg-7", "payments-worker");

    expect(capturedSql).toMatch(/ON CONFLICT \(message_id\) DO NOTHING/);
    expect(capturedParams).toEqual(["msg-7", "payments-worker"]);
  });
});
