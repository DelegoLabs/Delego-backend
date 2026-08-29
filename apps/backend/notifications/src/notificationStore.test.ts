import { describe, expect, it, vi } from "vitest";
import { bulkUpdateNotifications, listNotifications, type NotificationDb } from "./notificationStore.js";

describe("notification store", () => {
  it("builds scoped, searchable, paginated queries", async () => {
    const db: NotificationDb = { query: vi.fn().mockResolvedValue({ rows: [] }) };
    await listNotifications(db, { userId: "user-1", category: "transaction", read: false, search: "payment", limit: 10, offset: 20 });
    const [sql, params] = vi.mocked(db.query).mock.calls[0];
    expect(sql).toContain("user_id = $1");
    expect(sql).toContain("ILIKE $4");
    expect(params).toEqual(["user-1", "transaction", false, "%payment%", 10, 20]);
  });

  it("performs a single user-scoped bulk read update", async () => {
    const db: NotificationDb = { query: vi.fn().mockResolvedValue({ rows: [], rowCount: 2 }) };
    await expect(bulkUpdateNotifications(db, "user-1", ["a", "b"], "read")).resolves.toBe(2);
    expect(vi.mocked(db.query)).toHaveBeenCalledWith(
      expect.stringContaining("read = TRUE"),
      ["user-1", ["a", "b"]]
    );
  });
});