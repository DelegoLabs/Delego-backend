import { describe, it, expect, vi, beforeEach } from "vitest";

// ---------------------------------------------------------------------------
// Mock the db module so Sequelize never tries to connect to a real database.
// We replace `sequelize` with a minimal stub; Model.init/create will be spied
// on at the class level after we import the module under test.
// ---------------------------------------------------------------------------
vi.mock("../db.js", () => {
  return {
    sequelize: {
      define: vi.fn(),
    },
    connectDb: vi.fn(),
  };
});

// Mock @delegolabs/utils logger so tests stay quiet
vi.mock("@delegolabs/utils", () => ({
  createLogger: () => ({
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  }),
}));

// We also need to mock the sequelize Model so that `WalletSigningAuditLog.init`
// and `WalletSigningAuditLog.create` don't attempt real DB operations.
vi.mock("sequelize", async (importOriginal) => {
  const original = await importOriginal<typeof import("sequelize")>();

  class MockModel {
    static init = vi.fn();
    static create = vi.fn().mockResolvedValue({});
  }

  return {
    ...original,
    Model: MockModel,
  };
});

// Import after mocks are set up
import { insertAuditLog, type AuditLogParams } from "./auditLog.js";
import { Model } from "sequelize";

const mockCreate = Model.create as ReturnType<typeof vi.fn>;

beforeEach(() => {
  vi.clearAllMocks();
  mockCreate.mockResolvedValue({});
});

describe("insertAuditLog", () => {
  it("SUCCESS case: calls Model.create with correct arguments", async () => {
    const params: AuditLogParams = {
      walletId: "wallet-uuid-123",
      status: "SUCCESS",
      txHash: "abc123def456",
    };

    await insertAuditLog(params);

    expect(mockCreate).toHaveBeenCalledOnce();
    expect(mockCreate).toHaveBeenCalledWith({
      walletId: "wallet-uuid-123",
      status: "SUCCESS",
      txHash: "abc123def456",
    });
  });

  it("FAILURE case: calls Model.create with status='FAILURE' and txHash=null", async () => {
    const params: AuditLogParams = {
      walletId: "wallet-uuid-456",
      status: "FAILURE",
      txHash: null,
    };

    await insertAuditLog(params);

    expect(mockCreate).toHaveBeenCalledOnce();
    expect(mockCreate).toHaveBeenCalledWith({
      walletId: "wallet-uuid-456",
      status: "FAILURE",
      txHash: null,
    });
  });

  it("FAILURE case: omitting txHash defaults to null", async () => {
    const params: AuditLogParams = {
      walletId: "wallet-uuid-789",
      status: "FAILURE",
    };

    await insertAuditLog(params);

    expect(mockCreate).toHaveBeenCalledWith({
      walletId: "wallet-uuid-789",
      status: "FAILURE",
      txHash: null,
    });
  });

  it("re-throws when Model.create rejects", async () => {
    const dbError = new Error("DB connection lost");
    mockCreate.mockRejectedValueOnce(dbError);

    await expect(
      insertAuditLog({ walletId: "wallet-uuid-999", status: "SUCCESS", txHash: "somehash" })
    ).rejects.toThrow("DB connection lost");
  });

  // TypeScript compile-time safety: AuditLogParams must NOT allow secret key fields.
  // The @ts-expect-error directives confirm that passing those fields is a type error.
  it("TypeScript: disallows secret key fields in AuditLogParams", () => {
    // These lines must NOT compile — @ts-expect-error confirms a type error is present.

    // @ts-expect-error — privateKey is not a valid field
    const _a: AuditLogParams = { walletId: "w", status: "SUCCESS", privateKey: "secret" };

    // @ts-expect-error — secretKey is not a valid field
    const _b: AuditLogParams = { walletId: "w", status: "SUCCESS", secretKey: "secret" };

    // @ts-expect-error — secret is not a valid field
    const _c: AuditLogParams = { walletId: "w", status: "SUCCESS", secret: "secret" };

    // @ts-expect-error — seedPhrase is not a valid field
    const _d: AuditLogParams = { walletId: "w", status: "SUCCESS", seedPhrase: "secret" };

    // @ts-expect-error — mnemonic is not a valid field
    const _e: AuditLogParams = { walletId: "w", status: "SUCCESS", mnemonic: "secret" };

    // @ts-expect-error — encryptedPrivateKey is not a valid field
    const _f: AuditLogParams = { walletId: "w", status: "SUCCESS", encryptedPrivateKey: "secret" };

    // Suppress unused variable warnings
    void _a; void _b; void _c; void _d; void _e; void _f;
  });
});
