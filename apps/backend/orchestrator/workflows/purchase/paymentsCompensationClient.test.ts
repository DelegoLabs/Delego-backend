/**
 * Unit tests for #35 — HTTP client wrapping the payments service's order-level
 * release/refund compensation endpoints.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  createHttpPaymentsCompensationClient,
  defaultPaymentsCompensationClient,
  getPaymentsCompensationUrl,
} from "./paymentsCompensationClient.js";

describe("getPaymentsCompensationUrl", () => {
  const originalEnv = process.env.PAYMENTS_URL;
  afterEach(() => {
    if (originalEnv === undefined) delete process.env.PAYMENTS_URL;
    else process.env.PAYMENTS_URL = originalEnv;
  });

  it("defaults to http://localhost:3014", () => {
    delete process.env.PAYMENTS_URL;
    expect(getPaymentsCompensationUrl()).toBe("http://localhost:3014");
  });

  it("uses PAYMENTS_URL when set", () => {
    process.env.PAYMENTS_URL = "http://payments.internal:9999";
    expect(getPaymentsCompensationUrl()).toBe("http://payments.internal:9999");
  });
});

describe("defaultPaymentsCompensationClient", () => {
  it("throws 'not configured' for release()", async () => {
    await expect(defaultPaymentsCompensationClient.release("order-1")).rejects.toThrow(
      "PaymentsCompensationClient not configured"
    );
  });

  it("throws 'not configured' for refund()", async () => {
    await expect(defaultPaymentsCompensationClient.refund("order-1", "system_error")).rejects.toThrow(
      "PaymentsCompensationClient not configured"
    );
  });
});

describe("createHttpPaymentsCompensationClient", () => {
  const originalFetch = global.fetch;

  beforeEach(() => {
    global.fetch = vi.fn();
  });

  afterEach(() => {
    global.fetch = originalFetch;
  });

  it("POSTs to /api/v1/orders/:orderId/release and returns the outcome", async () => {
    vi.mocked(global.fetch).mockResolvedValue({
      ok: true,
      status: 200,
      text: async () =>
        JSON.stringify({
          data: { orderId: "order-1", escrowId: "42", status: "released", txHash: "tx-1", alreadySettled: false },
          error: null,
        }),
    } as Response);

    const client = createHttpPaymentsCompensationClient("http://payments.test");
    const result = await client.release("order-1");

    expect(global.fetch).toHaveBeenCalledWith(
      "http://payments.test/api/v1/orders/order-1/release",
      expect.objectContaining({ method: "POST" })
    );
    expect(result.status).toBe("released");
  });

  it("POSTs refundReasonCode in the body for refund()", async () => {
    vi.mocked(global.fetch).mockResolvedValue({
      ok: true,
      status: 200,
      text: async () =>
        JSON.stringify({
          data: { orderId: "order-1", escrowId: "42", status: "refunded", txHash: "tx-2", alreadySettled: false },
          error: null,
        }),
    } as Response);

    const client = createHttpPaymentsCompensationClient("http://payments.test");
    await client.refund("order-1", "merchant_cancelled");

    const call = vi.mocked(global.fetch).mock.calls[0];
    expect(call[0]).toBe("http://payments.test/api/v1/orders/order-1/refund");
    const body = JSON.parse((call[1] as RequestInit).body as string);
    expect(body).toEqual({ refundReasonCode: "merchant_cancelled" });
  });

  it("URL-encodes the orderId path segment", async () => {
    vi.mocked(global.fetch).mockResolvedValue({
      ok: true,
      status: 200,
      text: async () =>
        JSON.stringify({ data: { orderId: "a/b", escrowId: null, status: "released", txHash: null, alreadySettled: false }, error: null }),
    } as Response);

    const client = createHttpPaymentsCompensationClient("http://payments.test");
    await client.release("a/b");

    expect(global.fetch).toHaveBeenCalledWith(
      "http://payments.test/api/v1/orders/a%2Fb/release",
      expect.anything()
    );
  });

  it("throws when the fetch call itself rejects (network failure)", async () => {
    vi.mocked(global.fetch).mockRejectedValue(new Error("ECONNREFUSED"));

    const client = createHttpPaymentsCompensationClient("http://payments.test");
    await expect(client.release("order-1")).rejects.toThrow(/Payments service unavailable/);
  });

  it("throws with the server's error message when the response has ok:false", async () => {
    vi.mocked(global.fetch).mockResolvedValue({
      ok: false,
      status: 502,
      text: async () =>
        JSON.stringify({ data: null, error: { code: "ORDER_RELEASE_FAILED", message: "on-chain failure" } }),
    } as Response);

    const client = createHttpPaymentsCompensationClient("http://payments.test");
    await expect(client.release("order-1")).rejects.toThrow("on-chain failure");
  });

  it("throws when the response body is not valid JSON", async () => {
    vi.mocked(global.fetch).mockResolvedValue({
      ok: true,
      status: 200,
      text: async () => "not json",
    } as Response);

    const client = createHttpPaymentsCompensationClient("http://payments.test");
    await expect(client.release("order-1")).rejects.toThrow(/invalid response/);
  });

  it("throws when the response has no data even though ok:true", async () => {
    vi.mocked(global.fetch).mockResolvedValue({
      ok: true,
      status: 200,
      text: async () => JSON.stringify({ error: null }),
    } as Response);

    const client = createHttpPaymentsCompensationClient("http://payments.test");
    await expect(client.release("order-1")).rejects.toThrow(/empty compensation result/);
  });
});
