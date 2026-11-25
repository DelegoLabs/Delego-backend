import { describe, expect, it } from "vitest";
import { validateSsrfUrl, dispatchWithSsrfProtection, isPrivateOrReservedIp } from "./ssrfGuard.js";

function stubResolver(address: string, family: 4 | 6 = 4) {
  return async () => ({ address, family });
}

describe("validateSsrfUrl", () => {
  it("rejects loopback addresses", async () => {
    const result = await validateSsrfUrl("https://internal.example.com", {
      resolveHostname: stubResolver("127.0.0.1"),
    });
    expect(result).toEqual({ isValid: false, resolvedIp: "127.0.0.1", rejectionReason: "loopback" });
  });

  it("rejects RFC 1918 private ranges", async () => {
    const result = await validateSsrfUrl("https://internal.example.com", {
      resolveHostname: stubResolver("10.0.0.5"),
    });
    expect(result.isValid).toBe(false);
    expect(result.rejectionReason).toBe("private_ip");
  });

  it("rejects the AWS/GCP cloud metadata address", async () => {
    const result = await validateSsrfUrl("https://metadata.example.com", {
      resolveHostname: stubResolver("169.254.169.254"),
    });
    expect(result.rejectionReason).toBe("cloud_metadata");
  });

  it("rejects link-local addresses distinct from cloud metadata", async () => {
    const result = await validateSsrfUrl("https://link-local.example.com", {
      resolveHostname: stubResolver("169.254.1.1"),
    });
    expect(result.rejectionReason).toBe("link_local");
  });

  it("rejects non-HTTPS URLs", async () => {
    const result = await validateSsrfUrl("http://example.com", {
      resolveHostname: stubResolver("93.184.216.34"),
    });
    expect(result).toEqual({ isValid: false, rejectionReason: "unsupported_protocol" });
  });

  it("allows a legitimate public IPv4 address", async () => {
    const result = await validateSsrfUrl("https://merchant.example.com/webhook", {
      resolveHostname: stubResolver("93.184.216.34"),
    });
    expect(result).toEqual({ isValid: true, resolvedIp: "93.184.216.34" });
  });

  it("rejects malformed/unparseable IPs by failing closed", () => {
    expect(isPrivateOrReservedIp("not-an-ip", 4)).toBe(true);
  });
});

describe("dispatchWithSsrfProtection", () => {
  it("refuses to dispatch when DNS answers differently between validation and send (rebinding)", async () => {
    let call = 0;
    const flippingResolver = async () => {
      call++;
      return call === 1
        ? { address: "93.184.216.34", family: 4 as const }
        : { address: "10.0.0.1", family: 4 as const };
    };

    const { result, response } = await dispatchWithSsrfProtection(
      "https://merchant.example.com/webhook",
      JSON.stringify({ event: "order.created" }),
      { "Content-Type": "application/json" },
      { resolveHostname: flippingResolver },
    );

    expect(result.isValid).toBe(false);
    expect(result.rejectionReason).toBe("dns_rebinding");
    expect(response).toBeUndefined();
  });

  it("refuses to dispatch when initial validation fails", async () => {
    const { result, response } = await dispatchWithSsrfProtection(
      "https://internal.example.com/webhook",
      "{}",
      {},
      { resolveHostname: stubResolver("127.0.0.1") },
    );

    expect(result.isValid).toBe(false);
    expect(result.rejectionReason).toBe("loopback");
    expect(response).toBeUndefined();
  });
});
