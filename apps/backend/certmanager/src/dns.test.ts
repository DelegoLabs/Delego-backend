import { describe, expect, it } from "vitest";
import { MemoryDnsProvider } from "../src/acme/dns.js";

describe("MemoryDnsProvider", () => {
  it("records and removes TXT challenges", async () => {
    const dns = new MemoryDnsProvider();
    const challenge = {
      type: "dns-01" as const,
      domain: "*.example.com",
      value: "abc123",
      targetDomain: "example.com",
    };
    await dns.present(challenge);
    expect(dns.records.get("_acme-challenge.example.com")).toBe("abc123");
    await dns.cleanup(challenge);
    expect(dns.records.has("_acme-challenge.example.com")).toBe(false);
  });
});
