import { describe, it, expect } from "vitest";
import {
  validateFundEscrowRequest,
  type FundEscrowRequest,
} from "./validation.js";

// A valid base request to build test cases from
// Valid Stellar address: 'G' + 55 chars from [A-Z2-7] = 56 chars total
const VALID_MERCHANT = "GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";
const VALID_IDEMPOTENCY_KEY = "550e8400-e29b-41d4-a716-446655440000";

function validBody(): Record<string, unknown> {
  return {
    orderId: "order-123",
    buyerWalletId: "wallet-abc",
    merchantAddress: VALID_MERCHANT,
    amountStroops: "100000",
    idempotencyKey: VALID_IDEMPOTENCY_KEY,
  };
}

describe("validateFundEscrowRequest", () => {
  // ---------------------------------------------------------------------------
  // Happy path
  // ---------------------------------------------------------------------------
  it("returns ok with all valid fields", () => {
    const result = validateFundEscrowRequest(validBody());
    expect(result.ok).toBe(true);
    if (result.ok) {
      const v = result.value as FundEscrowRequest;
      expect(v.orderId).toBe("order-123");
      expect(v.buyerWalletId).toBe("wallet-abc");
      expect(v.merchantAddress).toBe(VALID_MERCHANT);
      expect(v.amountStroops).toBe("100000");
      expect(v.idempotencyKey).toBe(VALID_IDEMPOTENCY_KEY);
    }
  });

  // ---------------------------------------------------------------------------
  // orderId
  // ---------------------------------------------------------------------------
  it("fails when orderId is missing", () => {
    const body = validBody();
    delete body.orderId;
    const result = validateFundEscrowRequest(body);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.details?.field).toBe("orderId");
    }
  });

  it("fails when orderId is an empty string", () => {
    const result = validateFundEscrowRequest({ ...validBody(), orderId: "" });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.details?.field).toBe("orderId");
    }
  });

  // ---------------------------------------------------------------------------
  // buyerWalletId
  // ---------------------------------------------------------------------------
  it("fails when buyerWalletId is missing", () => {
    const body = validBody();
    delete body.buyerWalletId;
    const result = validateFundEscrowRequest(body);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.details?.field).toBe("buyerWalletId");
    }
  });

  it("fails when buyerWalletId is an empty string", () => {
    const result = validateFundEscrowRequest({ ...validBody(), buyerWalletId: "" });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.details?.field).toBe("buyerWalletId");
    }
  });

  // ---------------------------------------------------------------------------
  // merchantAddress
  // ---------------------------------------------------------------------------
  it("fails when merchantAddress is missing", () => {
    const body = validBody();
    delete body.merchantAddress;
    const result = validateFundEscrowRequest(body);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.details?.field).toBe("merchantAddress");
    }
  });

  it("fails when merchantAddress is an empty string", () => {
    const result = validateFundEscrowRequest({ ...validBody(), merchantAddress: "" });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.details?.field).toBe("merchantAddress");
    }
  });

  it("fails when merchantAddress does not match the Stellar address regex", () => {
    // Starts with 'A' instead of 'G'
    const result = validateFundEscrowRequest({
      ...validBody(),
      merchantAddress: "ACEZWKCA5VLDNRLN3RPRJMRZOX3Z6G5CHCGZMI1LXUQ0TE7BNMLLSZ",
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.details?.field).toBe("merchantAddress");
    }
  });

  it("fails when merchantAddress is too short", () => {
    const result = validateFundEscrowRequest({
      ...validBody(),
      merchantAddress: "GAAAAAAAAAAAAAAAAAAAAAAAA",
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.details?.field).toBe("merchantAddress");
    }
  });

  // ---------------------------------------------------------------------------
  // amountStroops
  // ---------------------------------------------------------------------------
  it("fails when amountStroops is missing", () => {
    const body = validBody();
    delete body.amountStroops;
    const result = validateFundEscrowRequest(body);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.details?.field).toBe("amountStroops");
    }
  });

  it("fails when amountStroops is an empty string", () => {
    const result = validateFundEscrowRequest({ ...validBody(), amountStroops: "" });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.details?.field).toBe("amountStroops");
    }
  });

  it("fails when amountStroops contains non-digit characters", () => {
    const result = validateFundEscrowRequest({ ...validBody(), amountStroops: "100.50" });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.details?.field).toBe("amountStroops");
    }
  });

  it("fails when amountStroops is '0'", () => {
    const result = validateFundEscrowRequest({ ...validBody(), amountStroops: "0" });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.details?.field).toBe("amountStroops");
      expect(result.error.message).toMatch(/greater than zero/i);
    }
  });

  it("fails when amountStroops exceeds Number.MAX_SAFE_INTEGER", () => {
    // 9007199254740992 = Number.MAX_SAFE_INTEGER + 1
    const result = validateFundEscrowRequest({
      ...validBody(),
      amountStroops: "9007199254740992",
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.details?.field).toBe("amountStroops");
      expect(result.error.message).toMatch(/9007199254740991/);
    }
  });

  it("accepts amountStroops equal to Number.MAX_SAFE_INTEGER", () => {
    const result = validateFundEscrowRequest({
      ...validBody(),
      amountStroops: "9007199254740991",
    });
    expect(result.ok).toBe(true);
  });

  // ---------------------------------------------------------------------------
  // idempotencyKey
  // ---------------------------------------------------------------------------
  it("fails when idempotencyKey is missing", () => {
    const body = validBody();
    delete body.idempotencyKey;
    const result = validateFundEscrowRequest(body);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.details?.field).toBe("idempotencyKey");
    }
  });

  it("fails when idempotencyKey is an empty string", () => {
    const result = validateFundEscrowRequest({ ...validBody(), idempotencyKey: "" });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.details?.field).toBe("idempotencyKey");
    }
  });

  it("fails when idempotencyKey is not a UUID v4", () => {
    const result = validateFundEscrowRequest({
      ...validBody(),
      idempotencyKey: "not-a-uuid",
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.details?.field).toBe("idempotencyKey");
      expect(result.error.message).toMatch(/UUID v4/i);
    }
  });

  it("fails when idempotencyKey is a UUID v1 (not v4)", () => {
    // UUID v1: version digit is '1' not '4'
    const result = validateFundEscrowRequest({
      ...validBody(),
      idempotencyKey: "550e8400-e29b-11d4-a716-446655440000",
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.details?.field).toBe("idempotencyKey");
    }
  });

  it("accepts idempotencyKey in uppercase UUID v4 format", () => {
    const result = validateFundEscrowRequest({
      ...validBody(),
      idempotencyKey: "550E8400-E29B-41D4-A716-446655440000",
    });
    expect(result.ok).toBe(true);
  });

  // ---------------------------------------------------------------------------
  // Fail-fast ordering
  // ---------------------------------------------------------------------------
  it("reports orderId error before buyerWalletId error when both are missing", () => {
    const result = validateFundEscrowRequest({
      merchantAddress: VALID_MERCHANT,
      amountStroops: "100000",
      idempotencyKey: VALID_IDEMPOTENCY_KEY,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.details?.field).toBe("orderId");
    }
  });
});
