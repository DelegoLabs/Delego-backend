import { describe, expect, it, vi } from "vitest";
import { DefaultCertificateDeployer } from "../src/deploy/deployer.js";
import type { StoredCertificate } from "../src/store/certificateStore.js";

const stored: StoredCertificate = {
  id: "cert_1",
  domains: ["example.com"],
  issuer: "Delego Local CA",
  serialNumber: "abcd",
  notBefore: new Date().toISOString(),
  notAfter: new Date(Date.now() + 86400000).toISOString(),
  status: "valid",
  autoRenew: true,
  nextRenewalAt: new Date(Date.now() + 86400000).toISOString(),
  certificatePem: "CERT",
  fullchainPem: "FULLCHAIN",
  privateKeyPem: "KEY",
  config: {
    domains: ["example.com"],
    acmeProvider: "letsencrypt",
    acmeAccountKey: "k",
    challengeType: "http-01",
    renewBeforeDays: 30,
    wildcardEnabled: false,
  },
  ctLogs: [],
};

describe("DefaultCertificateDeployer", () => {
  it("deploys via webhook", async () => {
    const fetchImpl = vi.fn(async () => new Response("ok", { status: 200 })) as unknown as typeof fetch;
    const deployer = new DefaultCertificateDeployer({ fetchImpl });
    const result = await deployer.deploy(stored, { target: "webhook", options: { url: "https://hook" } });
    expect(result.ok).toBe(true);
    expect(fetchImpl).toHaveBeenCalledWith(
      "https://hook",
      expect.objectContaining({ method: "POST", body: expect.stringContaining("FULLCHAIN") }),
    );
  });

  it("writes PEM files for nginx", async () => {
    const written: Record<string, string> = {};
    const deployer = new DefaultCertificateDeployer({
      writeFile: async (path, contents) => {
        written[path] = contents;
      },
    });
    const result = await deployer.deploy(stored, {
      target: "nginx",
      options: { certPath: "/etc/nginx/cert.pem", keyPath: "/etc/nginx/key.pem" },
    });
    expect(result.ok).toBe(true);
    expect(written["/etc/nginx/cert.pem"]).toBe("FULLCHAIN");
    expect(written["/etc/nginx/key.pem"]).toBe("KEY");
  });

  it("rejects an unknown target", async () => {
    const deployer = new DefaultCertificateDeployer();
    await expect(deployer.deploy(stored, { target: "ftp" as any })).rejects.toThrow();
  });
});
