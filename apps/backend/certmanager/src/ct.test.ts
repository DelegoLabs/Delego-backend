import { describe, expect, it, vi } from "vitest";
import { HttpCtLogSubmitter, NoopCtLogSubmitter } from "../src/ct/ctLog.js";
import type { IssuedCertificate } from "@delegolabs/types";

const issued: IssuedCertificate = {
  domains: ["example.com"],
  certificatePem: "-----BEGIN CERTIFICATE-----\nMIIB\n-----END CERTIFICATE-----",
  privateKeyPem: "key",
  issuer: "Delego Local CA",
  serialNumber: "abcd",
  notBefore: new Date().toISOString(),
  notAfter: new Date(Date.now() + 86400000).toISOString(),
};

describe("HttpCtLogSubmitter", () => {
  it("POSTs the certificate to each configured log", async () => {
    const fetchImpl = vi.fn(async () =>
      new Response(JSON.stringify({ sct: "sct-token" }), { status: 200 }),
    ) as unknown as typeof fetch;
    const submitter = new HttpCtLogSubmitter(
      ["https://ct1.example.com", "https://ct2.example.com"],
      fetchImpl,
    );
    const results = await submitter.submit(issued);
    expect(results).toHaveLength(2);
    expect(results[0].sct).toBe("sct-token");
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    expect(fetchImpl).toHaveBeenCalledWith(
      "https://ct1.example.com/ct/v1/add-chain",
      expect.objectContaining({ method: "POST" }),
    );
  });

  it("throws when a log rejects the submission", async () => {
    const fetchImpl = vi.fn(async () => new Response("nope", { status: 500 })) as unknown as typeof fetch;
    const submitter = new HttpCtLogSubmitter(["https://ct1.example.com"], fetchImpl);
    await expect(submitter.submit(issued)).rejects.toThrow(/CT log submission failed/);
  });
});

describe("NoopCtLogSubmitter", () => {
  it("records the attempt without network access", async () => {
    const results = await new NoopCtLogSubmitter().submit(issued);
    expect(results[0].logUrl).toBe("noop");
  });
});
