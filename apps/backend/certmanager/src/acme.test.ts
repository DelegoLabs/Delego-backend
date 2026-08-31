import { describe, expect, it, vi } from "vitest";
import { validateWildcardSupport, resolveDirectoryUrl } from "../src/acme/types.js";
import type { CertificateConfig } from "@delegolabs/types";

describe("validateWildcardSupport", () => {
  it("allows wildcard with dns-01", () => {
    expect(() =>
      validateWildcardSupport(["*.example.com"], "dns-01", true),
    ).not.toThrow();
  });

  it("rejects wildcard with http-01", () => {
    expect(() =>
      validateWildcardSupport(["*.example.com"], "http-01", true),
    ).toThrow(/dns-01/);
  });

  it("rejects wildcardEnabled without a wildcard domain", () => {
    expect(() =>
      validateWildcardSupport(["example.com"], "dns-01", true),
    ).toThrow(/no \*\./);
  });
});

describe("resolveDirectoryUrl", () => {
  it("maps known providers", () => {
    expect(resolveDirectoryUrl("letsencrypt")).toContain("letsencrypt.org");
    expect(resolveDirectoryUrl("zerossl")).toContain("zerossl.com");
    expect(resolveDirectoryUrl("buypass")).toContain("buypass.com");
  });

  it("requires a custom url for the custom provider", () => {
    expect(() => resolveDirectoryUrl("custom")).toThrow();
    expect(resolveDirectoryUrl("custom", "https://ca.example.com/dir")).toBe(
      "https://ca.example.com/dir",
    );
  });

  it("round-trips a valid config", () => {
    const config: CertificateConfig = {
      domains: ["example.com"],
      acmeProvider: "letsencrypt",
      acmeAccountKey: "key",
      challengeType: "http-01",
      renewBeforeDays: 30,
      wildcardEnabled: false,
    };
    expect(config.acmeProvider).toBe("letsencrypt");
  });
});
