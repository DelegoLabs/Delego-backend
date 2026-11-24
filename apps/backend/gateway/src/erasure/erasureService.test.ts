import { beforeEach, describe, expect, it, vi } from "vitest";
import { QueryTypes } from "sequelize";
import { CartItem } from "../models/CartItem.js";
import {
  createErasureRequest,
  executeAccountErasure,
  generateErasureCertificate,
  generateHash,
  getErasureCertificate,
  getErasureRequestStatus,
} from "./erasureService.js";

const { query } = vi.hoisted(() => ({ query: vi.fn() }));
vi.mock("../db.js", () => ({ sequelize: { query } }));
vi.mock("@delegolabs/utils", () => ({ createLogger: () => ({ info: vi.fn() }) }));
vi.mock("../models/User.js", () => ({ User: { update: vi.fn() } }));
vi.mock("../models/RefreshToken.js", () => ({ RefreshToken: { destroy: vi.fn() } }));
vi.mock("../models/OAuthAccount.js", () => ({ OAuthAccount: { destroy: vi.fn() } }));
vi.mock("../models/PasskeyCredential.js", () => ({ PasskeyCredential: { destroy: vi.fn() } }));
vi.mock("../models/Wallet.js", () => ({ Wallet: { destroy: vi.fn() } }));
vi.mock("../models/Delegation.js", () => ({ Delegation: { destroy: vi.fn() } }));
vi.mock("../models/Merchant.js", () => ({ Merchant: { destroy: vi.fn() } }));
vi.mock("../models/Cart.js", () => ({ Cart: { destroy: vi.fn() } }));
vi.mock("../models/CartItem.js", () => ({ CartItem: { destroy: vi.fn() } }));
vi.mock("../models/Review.js", () => ({ Review: { destroy: vi.fn() } }));
vi.mock("../models/DeliveryEvidence.js", () => ({ DeliveryEvidence: { destroy: vi.fn() } }));

const date = new Date("2026-01-01T00:00:00Z");
const input = {
  userId: "user-1",
  walletAddress: "wallet-1",
  confirmationHash: "confirmation",
  confirmationMethod: "two_factor" as const,
};
const requestRow = {
  id: "request-1", user_id: input.userId, wallet_address: input.walletAddress,
  confirmation_hash: input.confirmationHash, confirmation_method: input.confirmationMethod,
  status: "pending", created_at: date,
};
const certificateRow = {
  id: "certificate-1", user_id: input.userId, wallet_address: input.walletAddress,
  certificate_hash: "certificate-hash", issued_at: date,
};

beforeEach(() => vi.resetAllMocks());

describe("erasure query results", () => {
  it("maps a returned request row and binds optional metadata", async () => {
    query.mockResolvedValueOnce([requestRow]);
    await expect(createErasureRequest(input)).resolves.toEqual({
      id: "request-1", ...input, status: "pending", createdAt: date.toISOString(),
    });
    expect(query).toHaveBeenCalledWith(expect.stringContaining("INSERT INTO account_erasure_requests"), {
      bind: [input.userId, input.walletAddress, input.confirmationHash, "two_factor", null, null],
      type: QueryTypes.SELECT, useMaster: true,
    });
  });

  it("rejects an insert without a returned request", async () => {
    query.mockResolvedValueOnce([]);
    await expect(createErasureRequest(input)).rejects.toThrow("Erasure request insert returned no row");
  });

  it("maps a returned certificate row", async () => {
    query.mockResolvedValueOnce([certificateRow]);
    await expect(generateErasureCertificate("user-1", "wallet-1", 2, 0, 1)).resolves.toEqual({
      id: "certificate-1", userId: "user-1", walletAddress: "wallet-1",
      certificateHash: "certificate-hash", issuedAt: date.toISOString(),
    });
    expect(query).toHaveBeenCalledWith(expect.stringContaining("INSERT INTO erasure_certificates"),
      expect.objectContaining({ type: QueryTypes.SELECT, useMaster: true, bind: expect.any(Array) }));
  });

  it("rejects an insert without a returned certificate", async () => {
    query.mockResolvedValueOnce([]);
    await expect(generateErasureCertificate("user-1", "wallet-1", 0, 0, 0))
      .rejects.toThrow("Erasure certificate insert returned no row");
  });

  it("preserves missing status and certificate lookups", async () => {
    query.mockResolvedValue([]);
    await expect(getErasureRequestStatus("missing")).resolves.toBeUndefined();
    await expect(getErasureCertificate("missing")).resolves.toBeUndefined();
    expect(query).toHaveBeenNthCalledWith(1, expect.any(String), { bind: ["missing"], type: QueryTypes.SELECT });
    expect(query).toHaveBeenNthCalledWith(2, expect.any(String), { bind: ["missing"], type: QueryTypes.SELECT });
  });

  it("returns a lookup row directly", async () => {
    query.mockResolvedValueOnce([requestRow]).mockResolvedValueOnce([certificateRow]);
    await expect(getErasureRequestStatus("request-1")).resolves.toBe(requestRow);
    await expect(getErasureCertificate("certificate-hash")).resolves.toBe(certificateRow);
  });

  it.each([0, 2])("handles %i payment and cart rows without treating the first row as an array", async (count) => {
    const payments = Array.from({ length: count }, (_, i) => ({
      id: `payment-${i}`, buyer_address: `buyer-${i}`, seller_address: `seller-${i}`,
    }));
    const carts = Array.from({ length: count }, (_, i) => ({ id: `cart-${i}` }));
    query.mockImplementation(async (sql) => {
      const text = String(sql);
      if (text.includes("FROM payment_records")) return payments;
      if (text.includes("SELECT id FROM carts")) return carts;
      if (text.includes("INSERT INTO erasure_certificates")) return [certificateRow];
      return [];
    });
    await expect(executeAccountErasure("user-1", "wallet-1"))
      .resolves.toMatchObject({ anonymizedPaymentRecords: count, purgedPreferences: 1 });
    expect(CartItem.destroy).toHaveBeenCalledWith({ where: { cartId: carts.map(({ id }) => id) } });
    for (const payment of payments) {
      expect(query).toHaveBeenCalledWith(expect.stringContaining("INSERT INTO erasure_payment_hashes"), {
        bind: [payment.id, payment.buyer_address, generateHash(payment.buyer_address),
          payment.seller_address, generateHash(payment.seller_address)],
        type: QueryTypes.INSERT,
      });
    }
    for (const [, options] of query.mock.calls) {
      expect(options).toHaveProperty("bind");
      expect(options).not.toHaveProperty("replacements");
      expect(options).not.toHaveProperty("model");
    }
  });

  it("propagates query failures", async () => {
    query.mockRejectedValueOnce(new Error("database unavailable"));
    await expect(createErasureRequest(input)).rejects.toThrow("database unavailable");
  });
});

describe("generateHash", () => {
  it("works in ESM and rejects unsupported algorithms", () => {
    expect(generateHash("abc")).toBe("ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad");
    expect(generateHash("abc", "sha512")).toHaveLength(128);
    expect(() => generateHash("abc", "md5")).toThrow("Unsupported hash algorithm");
  });
});
