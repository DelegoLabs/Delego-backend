/**
 * Unit tests for #35 — HTTP client for merchant order cancellation used by
 * escrow compensation's confirmPurchase step.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  createHttpMerchantCancellationClient,
  defaultMerchantCancellationClient,
  getMerchantServiceUrl,
} from "./merchantCancellationClient.js";

describe("getMerchantServiceUrl", () => {
  const originalEnv = process.env.MERCHANT_SERVICE_URL;
  afterEach(() => {
    if (originalEnv === undefined) delete process.env.MERCHANT_SERVICE_URL;
    else process.env.MERCHANT_SERVICE_URL = originalEnv;
  });

  it("defaults to http://localhost:3015", () => {
    delete process.env.MERCHANT_SERVICE_URL;
    expect(getMerchantServiceUrl()).toBe("http://localhost:3015");
  });

  it("uses MERCHANT_SERVICE_URL when set", () => {
    process.env.MERCHANT_SERVICE_URL = "http://merchant.internal:9999";
    expect(getMerchantServiceUrl()).toBe("http://merchant.internal:9999");
  });
});

describe("defaultMerchantCancellationClient", () => {
  it("throws 'not configured' — no merchant service exists in this repo yet", async () => {
    await expect(defaultMerchantCancellationClient.cancel("morder-1", "system_error")).rejects.toThrow(
      "MerchantCancellationClient not configured"
    );
  });
});

describe("createHttpMerchantCancellationClient", () => {
  const originalFetch = global.fetch;

  beforeEach(() => {
    global.fetch = vi.fn();
  });

  afterEach(() => {
    global.fetch = originalFetch;
  });

  it("POSTs to /api/v1/merchant-orders/:id/cancel with the reason code", async () => {
    vi.mocked(global.fetch).mockResolvedValue({
      ok: true,
      status: 200,
      text: async () =>
        JSON.stringify({ data: { merchantOrderId: "morder-1", status: "cancelled" }, error: null }),
    } as Response);

    const client = createHttpMerchantCancellationClient("http://merchant.test");
    const result = await client.cancel("morder-1", "system_error");

    expect(global.fetch).toHaveBeenCalledWith(
      "http://merchant.test/api/v1/merchant-orders/morder-1/cancel",
      expect.objectContaining({ method: "POST" })
    );
    const call = vi.mocked(global.fetch).mock.calls[0];
    const body = JSON.parse((call[1] as RequestInit).body as string);
    expect(body).toEqual({ reasonCode: "system_error" });
    expect(result.status).toBe("cancelled");
  });

  it("throws when the fetch call itself rejects (network failure)", async () => {
    vi.mocked(global.fetch).mockRejectedValue(new Error("ECONNREFUSED"));

    const client = createHttpMerchantCancellationClient("http://merchant.test");
    await expect(client.cancel("morder-1", "system_error")).rejects.toThrow(/Merchant service unavailable/);
  });

  it("throws with the server's error message when the response has ok:false", async () => {
    vi.mocked(global.fetch).mockResolvedValue({
      ok: false,
      status: 409,
      text: async () =>
        JSON.stringify({ data: null, error: { code: "NOT_CANCELLABLE", message: "order already shipped" } }),
    } as Response);

    const client = createHttpMerchantCancellationClient("http://merchant.test");
    await expect(client.cancel("morder-1", "system_error")).rejects.toThrow("order already shipped");
  });

  it("throws when the response body is not valid JSON", async () => {
    vi.mocked(global.fetch).mockResolvedValue({
      ok: true,
      status: 200,
      text: async () => "<html>not json</html>",
    } as Response);

    const client = createHttpMerchantCancellationClient("http://merchant.test");
    await expect(client.cancel("morder-1", "system_error")).rejects.toThrow(/invalid response/);
  });
});
