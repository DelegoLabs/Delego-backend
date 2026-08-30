import { describe, it, expect, beforeEach } from "vitest";
import {
  SoftDeleteError,
  softDeleteRow,
  restoreRow,
  hardDeleteRow,
  findById,
  findAll,
  withNotDeleted,
  withOnlyDeleted,
  collectSoftDeleteMetrics,
  type SoftDeleteRow,
} from "./softDeleteTable.js";
import type { Queryable } from "./types.js";

/**
 * A minimal in-memory Postgres-compatible fake: interprets just enough of
 * the SQL this module generates to exercise real behavior end-to-end
 * without a live database, mirroring how the repo already fakes Redis
 * with ioredis-mock for the same reason (see packages/cache). Holds one
 * or more named tables so cascade tests can exercise cross-table updates.
 */
class FakeDb implements Queryable {
  private tables = new Map<string, Map<string, SoftDeleteRow>>();

  seed(tableName: string, row: SoftDeleteRow): void {
    if (!this.tables.has(tableName)) this.tables.set(tableName, new Map());
    this.tables.get(tableName)!.set(row.id, { ...row });
  }

  get(tableName: string, id: string): SoftDeleteRow | undefined {
    return this.tables.get(tableName)?.get(id);
  }

  async query<Row extends Record<string, unknown> = Record<string, unknown>>(
    text: string,
    values: unknown[] = []
  ): Promise<{ rows: Row[]; rowCount: number | null }> {
    const sql = text.replace(/\s+/g, " ").trim();
    const tableMatch = sql.match(/(?:UPDATE|FROM)\s+"([a-zA-Z_]+)"/);
    const tableName = tableMatch?.[1];
    if (!tableName) throw new Error(`FakeDb: could not parse table name from: ${sql}`);
    const rows = this.tables.get(tableName) ?? new Map<string, SoftDeleteRow>();
    this.tables.set(tableName, rows);

    if (sql.startsWith("UPDATE") && sql.includes("SET deleted_at = NOW()")) {
      const whereFk = sql.match(/WHERE "([a-zA-Z_]+)" = \$1/)?.[1] ?? "id";
      const [matchValue, deletedBy, reason] = values as [string, string, string | null];
      let count = 0;
      for (const row of rows.values()) {
        if (row[whereFk] === matchValue && row.deleted_at === null) {
          row.deleted_at = new Date();
          row.deleted_by = deletedBy;
          row.delete_reason = reason;
          count += 1;
        }
      }
      return { rows: [] as unknown as Row[], rowCount: count };
    }

    if (sql.startsWith("UPDATE") && sql.includes("SET deleted_at = NULL")) {
      const [id] = values as [string];
      const row = rows.get(id);
      if (!row || row.deleted_at === null) return { rows: [] as unknown as Row[], rowCount: 0 };
      row.deleted_at = null;
      row.deleted_by = null;
      row.delete_reason = null;
      return { rows: [] as unknown as Row[], rowCount: 1 };
    }

    if (sql.startsWith("DELETE FROM")) {
      const [id] = values as [string];
      const row = rows.get(id);
      const requireSoftDeleted = sql.includes("deleted_at IS NOT NULL");
      if (!row || (requireSoftDeleted && row.deleted_at === null)) {
        return { rows: [] as unknown as Row[], rowCount: 0 };
      }
      rows.delete(id);
      return { rows: [] as unknown as Row[], rowCount: 1 };
    }

    if (sql.startsWith("SELECT * FROM") && sql.includes("WHERE id = $1")) {
      const [id] = values as [string];
      const row = rows.get(id);
      const includeDeleted = !sql.includes("AND deleted_at IS NULL");
      if (!row) return { rows: [] as unknown as Row[], rowCount: 0 };
      if (!includeDeleted && row.deleted_at !== null) {
        return { rows: [] as unknown as Row[], rowCount: 0 };
      }
      return { rows: [row as unknown as Row], rowCount: 1 };
    }

    if (sql.startsWith("SELECT * FROM")) {
      const onlyDeleted = sql.includes("deleted_at IS NOT NULL");
      const all = [...rows.values()].filter((r) =>
        onlyDeleted ? r.deleted_at !== null : r.deleted_at === null
      );
      return { rows: all as unknown as Row[], rowCount: all.length };
    }

    if (sql.startsWith("SELECT COUNT(*)")) {
      const count = [...rows.values()].filter((r) => r.deleted_at !== null).length;
      return {
        rows: [{ soft_deleted_count: String(count) } as unknown as Row],
        rowCount: 1,
      };
    }

    throw new Error(`FakeDb: unhandled query: ${sql}`);
  }
}

describe("softDeleteRow", () => {
  let db: FakeDb;

  beforeEach(() => {
    db = new FakeDb();
    db.seed("users", { id: "u1", deleted_at: null, deleted_by: null, delete_reason: null });
  });

  it("soft-deletes an active row", async () => {
    const result = await softDeleteRow(db, { tableName: "users" }, "u1", "admin-1", "GDPR request");
    expect(result.deleted).toBe(true);

    const row = await findById(db, { tableName: "users" }, "u1", true);
    expect(row?.deleted_at).not.toBeNull();
    expect(row?.deleted_by).toBe("admin-1");
    expect(row?.delete_reason).toBe("GDPR request");
  });

  it("is idempotent: deleting an already-deleted row reports deleted: false", async () => {
    await softDeleteRow(db, { tableName: "users" }, "u1", "admin-1");
    const second = await softDeleteRow(db, { tableName: "users" }, "u1", "admin-1");
    expect(second.deleted).toBe(false);
  });

  it("throws SoftDeleteError when requireReason is set and no reason is given", async () => {
    await expect(
      softDeleteRow(db, { tableName: "users", options: { requireReason: true } }, "u1", "admin-1")
    ).rejects.toThrow(SoftDeleteError);
  });

  it("allows deletion when requireReason is set and a reason is given", async () => {
    const result = await softDeleteRow(
      db,
      { tableName: "users", options: { requireReason: true } },
      "u1",
      "admin-1",
      "user requested account closure"
    );
    expect(result.deleted).toBe(true);
  });

  it("rejects a malicious/invalid table name rather than interpolating it", async () => {
    await expect(
      softDeleteRow(db, { tableName: "users; DROP TABLE users;--" }, "u1", "admin-1")
    ).rejects.toThrow(SoftDeleteError);
  });

  it("cascades to related child tables when cascade is enabled", async () => {
    db.seed("orders", { id: "o1", user_id: "u1", deleted_at: null, deleted_by: null, delete_reason: null });

    await softDeleteRow(
      db,
      {
        tableName: "users",
        options: { cascade: true },
        cascadeRelations: [{ childTable: "orders", foreignKeyColumn: "user_id" }],
      },
      "u1",
      "admin-1",
      "account closure"
    );

    const order = db.get("orders", "o1");
    expect(order?.deleted_at).not.toBeNull();
    expect(order?.delete_reason).toBe("cascade: account closure");
  });

  it("does not cascade when cascade is false, even with relations configured", async () => {
    db.seed("orders", { id: "o1", user_id: "u1", deleted_at: null, deleted_by: null, delete_reason: null });

    await softDeleteRow(
      db,
      {
        tableName: "users",
        options: { cascade: false },
        cascadeRelations: [{ childTable: "orders", foreignKeyColumn: "user_id" }],
      },
      "u1",
      "admin-1"
    );

    const order = db.get("orders", "o1");
    expect(order?.deleted_at).toBeNull();
  });
});

describe("restoreRow", () => {
  it("restores a soft-deleted row", async () => {
    const db = new FakeDb();
    db.seed("users", { id: "u1", deleted_at: new Date(), deleted_by: "admin", delete_reason: "test" });

    const result = await restoreRow(db, { tableName: "users" }, "u1");
    expect(result.restored).toBe(true);

    const row = await findById(db, { tableName: "users" }, "u1");
    expect(row?.deleted_at).toBeNull();
    expect(row?.deleted_by).toBeNull();
  });

  it("reports restored: false for a row that is not deleted", async () => {
    const db = new FakeDb();
    db.seed("users", { id: "u1", deleted_at: null, deleted_by: null, delete_reason: null });

    const result = await restoreRow(db, { tableName: "users" }, "u1");
    expect(result.restored).toBe(false);
  });

  it("reports restored: false for a non-existent row", async () => {
    const db = new FakeDb();
    db.seed("users", { id: "placeholder", deleted_at: null, deleted_by: null, delete_reason: null });
    const result = await restoreRow(db, { tableName: "users" }, "missing");
    expect(result.restored).toBe(false);
  });
});

describe("hardDeleteRow", () => {
  it("throws when confirm is not explicitly true", async () => {
    const db = new FakeDb();
    db.seed("users", { id: "u1", deleted_at: new Date(), deleted_by: "admin", delete_reason: "gdpr" });

    // @ts-expect-error -- intentionally testing the guard against a missing confirm flag
    await expect(hardDeleteRow(db, { tableName: "users" }, "u1", {})).rejects.toThrow(SoftDeleteError);
  });

  it("hard-deletes a soft-deleted row when confirmed", async () => {
    const db = new FakeDb();
    db.seed("users", { id: "u1", deleted_at: new Date(), deleted_by: "admin", delete_reason: "gdpr" });

    const result = await hardDeleteRow(db, { tableName: "users" }, "u1", { confirm: true });
    expect(result.deleted).toBe(true);

    const row = await findById(db, { tableName: "users" }, "u1", true);
    expect(row).toBeNull();
  });

  it("refuses to hard-delete an active (not soft-deleted) row by default", async () => {
    const db = new FakeDb();
    db.seed("users", { id: "u1", deleted_at: null, deleted_by: null, delete_reason: null });

    const result = await hardDeleteRow(db, { tableName: "users" }, "u1", { confirm: true });
    expect(result.deleted).toBe(false);

    const row = await findById(db, { tableName: "users" }, "u1", true);
    expect(row).not.toBeNull();
  });

  it("hard-deletes an active row when requireSoftDeletedFirst is disabled", async () => {
    const db = new FakeDb();
    db.seed("users", { id: "u1", deleted_at: null, deleted_by: null, delete_reason: null });

    const result = await hardDeleteRow(db, { tableName: "users" }, "u1", {
      confirm: true,
      requireSoftDeletedFirst: false,
    });
    expect(result.deleted).toBe(true);
  });
});

describe("findById / findAll", () => {
  it("findById excludes soft-deleted rows by default", async () => {
    const db = new FakeDb();
    db.seed("users", { id: "u1", deleted_at: new Date(), deleted_by: "a", delete_reason: "r" });

    expect(await findById(db, { tableName: "users" }, "u1")).toBeNull();
    expect(await findById(db, { tableName: "users" }, "u1", true)).not.toBeNull();
  });

  it("findAll returns only active rows by default and only deleted with onlyDeleted", async () => {
    const db = new FakeDb();
    db.seed("users", { id: "u1", deleted_at: null, deleted_by: null, delete_reason: null });
    db.seed("users", { id: "u2", deleted_at: new Date(), deleted_by: "a", delete_reason: "r" });

    const active = await findAll(db, { tableName: "users" });
    expect(active.map((r) => r.id)).toEqual(["u1"]);

    const deleted = await findAll(db, { tableName: "users" }, { onlyDeleted: true });
    expect(deleted.map((r) => r.id)).toEqual(["u2"]);
  });
});

describe("withNotDeleted / withOnlyDeleted", () => {
  it("appends the filter to a non-empty WHERE fragment", () => {
    expect(withNotDeleted("status = 'active'")).toBe("status = 'active' AND deleted_at IS NULL");
    expect(withOnlyDeleted("status = 'active'")).toBe("status = 'active' AND deleted_at IS NOT NULL");
  });

  it("returns just the filter when the base fragment is empty", () => {
    expect(withNotDeleted("")).toBe("deleted_at IS NULL");
    expect(withOnlyDeleted("")).toBe("deleted_at IS NOT NULL");
  });
});

describe("collectSoftDeleteMetrics", () => {
  it("counts soft-deleted rows and reports zeroed restore stats with no events", async () => {
    const db = new FakeDb();
    db.seed("users", { id: "u1", deleted_at: null, deleted_by: null, delete_reason: null });
    db.seed("users", { id: "u2", deleted_at: new Date(), deleted_by: "a", delete_reason: "r" });
    db.seed("users", { id: "u3", deleted_at: new Date(), deleted_by: "a", delete_reason: "r" });

    const metrics = await collectSoftDeleteMetrics(db, { tableName: "users" });
    expect(metrics.tableName).toBe("users");
    expect(metrics.softDeletedCount).toBe(2);
    expect(metrics.restoredCount).toBe(0);
    expect(metrics.avgTimeToRestore).toBe(0);
  });

  it("computes avgTimeToRestore in hours from provided restore events", async () => {
    const db = new FakeDb();
    db.seed("users", { id: "u1", deleted_at: null, deleted_by: null, delete_reason: null });
    const deletedAt = new Date("2026-01-01T00:00:00Z");
    const restoredAt = new Date("2026-01-01T02:00:00Z"); // 2 hours later

    const metrics = await collectSoftDeleteMetrics(db, { tableName: "users" }, [
      { deletedAt, restoredAt },
    ]);

    expect(metrics.restoredCount).toBe(1);
    expect(metrics.avgTimeToRestore).toBeCloseTo(2);
  });
});
