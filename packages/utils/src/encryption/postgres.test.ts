/**
 * Tests for the Postgres-backed persistence of the encryption module (#68):
 *  - PostgresEncryptionKeyVersionStore against `encryption_key_versions`
 *  - PostgresKeyAccessAuditSink against `encryption_audit_log`
 *
 * Both are tested against a psql-mock that records the executed SQL, so no
 * database is required.
 */

import { describe, expect, it } from "vitest";
import { PostgresEncryptionKeyVersionStore, PostgresKeyAccessAuditSink } from "./postgres.js";
import type { Queryable } from "./postgres.js";
import type { EncryptionKeyVersionRow } from "./rotation.js";
import { EncryptionError } from "./cipher.js";

class PsqlMock implements Queryable {
  rows: Record<string, unknown>[][] = [];
  statements: { text: string; values: unknown[] }[] = [];

  async query<Row extends Record<string, unknown> = Record<string, unknown>>(
    text: string,
    values?: unknown[]
  ): Promise<{ rows: Row[]; rowCount: number | null }> {
    this.statements.push({ text, values: values ?? [] });
    const rows = (this.rows.shift() ?? []) as Row[];
    return { rows, rowCount: rows.length };
  }

  /** Queue a result set for the next query call. */
  queue(rows: Record<string, unknown>[]): void {
    this.rows.push(rows);
  }
}

const keyRow: EncryptionKeyVersionRow = {
  keyId: "delego-pii",
  version: 2,
  keyProvider: "aws_kms",
  wrappedKey: "bcrypt:…wrapped…",
  activatedAt: "2026-09-24T00:00:00.000Z",
  status: "active",
};

describe("PostgresEncryptionKeyVersionStore", () => {
  it("inserts a row into encryption_key_versions (upsert)", async () => {
    const db = new PsqlMock();
    const store = new PostgresEncryptionKeyVersionStore(db);

    await store.insert(keyRow);

    expect(db.statements).toHaveLength(1);
    const sql = db.statements[0];
    expect(sql.text).toContain("INSERT INTO encryption_key_versions");
    expect(sql.text).toContain("ON CONFLICT (key_id, version)");
    expect(sql.values).toEqual([
      "delego-pii", 2, "aws_kms", "bcrypt:…wrapped…", new Date(keyRow.activatedAt), "active",
    ]);
  });

  it("maps a stored row back to EncryptionKeyVersionRow", async () => {
    const db = new PsqlMock();
    db.queue([
      {
        key_id: "delego-pii",
        version: 2,
        key_provider: "aws_kms",
        wrapped_key: "abc",
        activated_at: "2026-09-24T00:00:00.000Z",
        status: "previous",
      },
    ]);
    const store = new PostgresEncryptionKeyVersionStore(db);

    const row = await store.get("delego-pii", 2);

    expect(row).toEqual({
      keyId: "delego-pii",
      version: 2,
      keyProvider: "aws_kms",
      wrappedKey: "abc",
      activatedAt: "2026-09-24T00:00:00.000Z",
      status: "previous",
    });
    expect(db.statements[0].values).toEqual(["delego-pii", 2]);
  });

  it("lists rows in ascending version order and updates status", async () => {
    const db = new PsqlMock();
    db.queue([
      { key_id: "k", version: 1, key_provider: "local", wrapped_key: "w1", activated_at: "2026-01-01T00:00:00.000Z", status: "retired" },
      { key_id: "k", version: 2, key_provider: "local", wrapped_key: "w2", activated_at: "2026-02-01T00:00:00.000Z", status: "previous" },
    ]);
    const store = new PostgresEncryptionKeyVersionStore(db);

    const rows = await store.list("k");
    await store.updateStatus("k", 1, "retired");

    expect(rows).toHaveLength(2);
    expect(rows[1].version).toBe(2);
    expect(db.statements[1].text).toContain("UPDATE encryption_key_versions");
    expect(db.statements[1].values).toEqual(["k", 1, "retired"]);
  });

  it("returns undefined for a missing row", async () => {
    const db = new PsqlMock();
    db.queue([]);
    const store = new PostgresEncryptionKeyVersionStore(db);

    await expect(store.get("delego-pii", 99)).resolves.toBeUndefined();
  });
});

describe("PostgresKeyAccessAuditSink", () => {
  it("writes an audit record to encryption_audit_log", async () => {
    const db = new PsqlMock();
    const sink = new PostgresKeyAccessAuditSink(db);

    await sink.write({
      id: "00000000-0000-0000-0000-000000000001",
      occurredAt: "2026-09-24T00:00:00.000Z",
      table: "users",
      column: "email",
      operation: "decrypt",
      keyId: "delego-pii",
      keyVersion: 2,
      actorRole: "support",
      context: { tenantId: "acme" },
      success: false,
      error: "Access denied",
    });

    expect(db.statements).toHaveLength(1);
    const sql = db.statements[0];
    expect(sql.text).toContain("INSERT INTO encryption_audit_log");
    expect(sql.values).toContain(JSON.stringify({ tenantId: "acme" }));
    expect(sql.values).toContain(false);
    expect(sql.values).toContain("Access denied");
  });

  it("rethrows a DB failure unless failOpen is set", async () => {
    const db = new PsqlMock();
    const failing = {
      async query(): Promise<{ rows: never[]; rowCount: number }> {
        throw new Error("connection refused");
      },
    } as unknown as Queryable;

    const record = {
      id: "1",
      occurredAt: "2026-09-24T00:00:00.000Z",
      table: "t",
      column: "c",
      operation: "decrypt",
      keyId: "k",
      keyVersion: 1,
      actorRole: null,
      context: {},
      success: false,
      error: "boom",
    };

    await expect(new PostgresKeyAccessAuditSink(failing).write(record)).rejects.toThrow(EncryptionError);
    expect(db.statements).toHaveLength(0);
  });

  it("swallows failures when failOpen is enabled", async () => {
    const failing = {
      async query(): Promise<{ rows: never[]; rowCount: number }> {
        throw new Error("connection refused");
      },
    } as unknown as Queryable;

    const sink = new PostgresKeyAccessAuditSink(failing, { failOpen: true });
    await expect(
      sink.write({
        id: "1",
        occurredAt: "2026-09-24T00:00:00.000Z",
        table: "t",
        column: "c",
        operation: "encrypt",
        keyId: "k",
        keyVersion: 1,
        actorRole: null,
        context: {},
        success: true,
      })
    ).resolves.toBeUndefined();
  });
});