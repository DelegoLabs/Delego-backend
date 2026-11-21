import { describe, expect, it } from "vitest";
import {
  REDACTED_SECRET_PLACEHOLDER,
  defaultQueryLogSanitizer,
  createSanitizingQueryLogger,
} from "./sqlSanitizer.js";

describe("defaultQueryLogSanitizer", () => {
  it("redacts a Stellar secret key bound as a query parameter", () => {
    const sqlQuery = "UPDATE wallets SET secret_key = $1 WHERE id = $2";
    const stellarSecret = "S" + "A".repeat(55);
    const { safeParams } = defaultQueryLogSanitizer.sanitize(sqlQuery, [stellarSecret, "wallet-1"]);

    expect(safeParams[0]).toBe(REDACTED_SECRET_PLACEHOLDER);
    expect(safeParams[1]).toBe("wallet-1");
  });

  it("redacts a password column by name regardless of the bound value's shape", () => {
    const sqlQuery = "INSERT INTO users (email, password) VALUES ($1, $2)";
    const { safeParams } = defaultQueryLogSanitizer.sanitize(sqlQuery, [
      "user@example.com",
      "plaintext-not-even-hashed",
    ]);

    expect(safeParams[0]).toBe("user@example.com");
    expect(safeParams[1]).toBe(REDACTED_SECRET_PLACEHOLDER);
  });

  it("redacts a JWT embedded inside a free-text parameter", () => {
    const jwt =
      "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dozjgNryP4J3jVmNHl0w5N_XgL0n3I9PlFUP0THsR8U";
    const sqlQuery = "INSERT INTO audit_log (note) VALUES ($1)";
    const { safeParams } = defaultQueryLogSanitizer.sanitize(sqlQuery, [`session token: ${jwt}`]);

    expect(safeParams[0]).toBe(`session token: ${REDACTED_SECRET_PLACEHOLDER}`);
  });

  it("redacts a bcrypt hash bound to an UPDATE ... SET clause", () => {
    const sqlQuery = "UPDATE users SET password_hash = $1 WHERE id = $2";
    const bcryptHash = "$2b$10$" + "a".repeat(53);
    const { safeParams } = defaultQueryLogSanitizer.sanitize(sqlQuery, [bcryptHash, "user-1"]);

    expect(safeParams[0]).toBe(REDACTED_SECRET_PLACEHOLDER);
  });

  it("redacts secrets inlined directly in the query text (unparameterized)", () => {
    const stellarSecret = "S" + "B".repeat(55);
    const sqlQuery = `SELECT * FROM wallets WHERE secret_key = '${stellarSecret}'`;
    const { safeQuery } = defaultQueryLogSanitizer.sanitize(sqlQuery, []);

    expect(safeQuery).not.toContain(stellarSecret);
    expect(safeQuery).toContain(REDACTED_SECRET_PLACEHOLDER);
  });

  it("leaves non-sensitive params and columns untouched", () => {
    const sqlQuery = "UPDATE orders SET status = $1 WHERE id = $2";
    const { safeQuery, safeParams } = defaultQueryLogSanitizer.sanitize(sqlQuery, ["shipped", "order-1"]);

    expect(safeQuery).toBe(sqlQuery);
    expect(safeParams).toEqual(["shipped", "order-1"]);
  });

  it("passes through non-string parameter values untouched when not sensitive", () => {
    const sqlQuery = "UPDATE orders SET total_cents = $1 WHERE id = $2";
    const { safeParams } = defaultQueryLogSanitizer.sanitize(sqlQuery, [4999, "order-1"]);

    expect(safeParams[0]).toBe(4999);
  });
});

describe("createSanitizingQueryLogger", () => {
  it("sanitizes before forwarding to the sink", () => {
    const lines: string[] = [];
    const logger = createSanitizingQueryLogger((msg) => lines.push(msg));
    const stellarSecret = "S" + "C".repeat(55);

    logger(`SELECT * FROM wallets WHERE secret_key = '${stellarSecret}'`);

    expect(lines).toHaveLength(1);
    expect(lines[0]).not.toContain(stellarSecret);
    expect(lines[0]).toContain(REDACTED_SECRET_PLACEHOLDER);
  });
});
