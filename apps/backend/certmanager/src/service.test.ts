import { describe, expect, it } from "vitest";
import { CertificateService } from "../src/service.js";
import { InMemoryCertificateStore } from "../src/store/certificateStore.js";
import { MemoryDnsProvider } from "../src/acme/dns.js";
import { NoopCtLogSubmitter } from "../src/ct/ctLog.js";
import { DefaultCertificateDeployer } from "../src/deploy/deployer.js";
import { StubAcmeClient, type AcmeClient, type AcmeIssueResult, type IssueInput } from "../src/acme/client.js";
import type { CertificateConfig } from "@delegolabs/types";
import type { StoredCertificate as Stored } from "../src/store/certificateStore.js";

const baseConfig: CertificateConfig = {
  domains: ["example.com"],
  acmeProvider: "letsencrypt",
  acmeAccountKey: "account-key",
  challengeType: "http-01",
  renewBeforeDays: 30,
  wildcardEnabled: false,
};

function makeService(acmeClient?: AcmeClient, store = new InMemoryCertificateStore()) {
  return new CertificateService({
    store,
    acmeClient,
    ctSubmitter: new NoopCtLogSubmitter(),
    deployer: new DefaultCertificateDeployer(),
    now: () => new Date("2026-01-01T00:00:00Z"),
  });
}

class FailingAcmeClient implements AcmeClient {
  readonly provider = "custom" as const;
  readonly directoryUrl = "fail://";
  async issue(_input: IssueInput): Promise<AcmeIssueResult> {
    throw new Error("ACME order failed: rate limited");
  }
  async revoke(): Promise<void> {
    throw new Error("revoke failed");
  }
}

describe("CertificateService.issue", () => {
  it("issues a certificate and exposes it in inventory", async () => {
    const service = makeService();
    const cert = await service.issue(baseConfig);
    expect(cert.status).toBe("valid");
    expect(cert.domains).toEqual(["example.com"]);
    expect(cert.issuer).toBe("Delego Local CA");

    const inventory = await service.inventory();
    expect(inventory).toHaveLength(1);
    expect(inventory[0].id).toBe(cert.id);

    const metrics = await service.metrics();
    expect(metrics.totalCertificates).toBe(1);
    expect(metrics.renewalSuccessRate).toBe(1);
  });

  it("submits to CT logs when enabled (noop in test)", async () => {
    const service = makeService();
    const cert = await service.issue(baseConfig);
    const full = await service.get(cert.id);
    expect(full?.id).toBe(cert.id);
  });
});

describe("CertificateService wildcard", () => {
  it("issues a wildcard cert via dns-01 and presents the DNS challenge", async () => {
    const dns = new MemoryDnsProvider();
    const presented: string[] = [];
    const spy: ReturnType<typeof makeSpy> = makeSpy(dns, presented);

    function makeSpy(provider: MemoryDnsProvider, log: string[]) {
      return {
        type: "memory" as const,
        present: async (c: any) => {
          log.push(c.targetDomain);
          await provider.present(c);
        },
        cleanup: async (c: any) => {
          await provider.cleanup(c);
        },
      };
    }

    const svc = new CertificateService({
      store: new InMemoryCertificateStore(),
      acmeClient: new StubAcmeClient(),
      ctSubmitter: new NoopCtLogSubmitter(),
      deployer: new DefaultCertificateDeployer(),
      dnsProviderFactory: () => spy,
      now: () => new Date("2026-01-01T00:00:00Z"),
    });

    const config: CertificateConfig = {
      ...baseConfig,
      domains: ["*.example.com", "example.com"],
      challengeType: "dns-01",
      wildcardEnabled: true,
      dnsProvider: { type: "cloudflare", credentials: { apiToken: "t", zoneId: "z" } },
    };
    const cert = await svc.issue(config);
    expect(cert.status).toBe("valid");
    expect(presented).toContain("example.com");
    expect(dns.records.size).toBe(0); // cleaned up after issuance
  });

  it("rejects wildcard without dns-01", async () => {
    const svc = makeService();
    await expect(
      svc.issue({ ...baseConfig, domains: ["*.example.com"], wildcardEnabled: true }),
    ).rejects.toThrow(/dns-01/);
  });
});

describe("CertificateService renewal", () => {
  it("renews certificates whose window has been reached", async () => {
    const store = new InMemoryCertificateStore();
    const service = new CertificateService({
      store,
      acmeClient: new StubAcmeClient(),
      ctSubmitter: new NoopCtLogSubmitter(),
      deployer: new DefaultCertificateDeployer(),
      now: () => new Date("2026-01-01T00:00:00Z"),
    });

    // Seed a certificate that is already due for renewal but still valid.
    const seeded: Stored = {
      id: "cert_due_ok",
      domains: ["example.com"],
      issuer: "Delego Local CA",
      serialNumber: "old",
      notBefore: new Date("2026-01-01").toISOString(),
      notAfter: new Date("2026-12-31").toISOString(),
      status: "valid",
      autoRenew: true,
      nextRenewalAt: new Date("2026-02-01").toISOString(),
      certificatePem: "OLD",
      fullchainPem: "OLD",
      privateKeyPem: "OLD",
      config: { ...baseConfig, renewBeforeDays: 30 },
      ctLogs: [],
    };
    await store.save(seeded);

    const summary = await service.renewDueCertificates(new Date("2026-06-01T00:00:00Z"));
    expect(summary.checked).toBe(1);
    expect(summary.renewed).toBe(1);
    expect(summary.failed).toBe(0);

    const renewed = await service.get("cert_due_ok");
    expect(renewed?.lastRenewalAttempt).toBeDefined();
    // The renewed cert is valid for ~90 days from the (real) renewal moment.
    expect(new Date(renewed!.notAfter).getTime()).toBeGreaterThan(Date.now());
  });

  it("records a failure when ACME renewal fails (renewal failure scenario)", async () => {
    const store = new InMemoryCertificateStore();
    const service = new CertificateService({
      store,
      acmeClient: new FailingAcmeClient(),
      ctSubmitter: new NoopCtLogSubmitter(),
      deployer: new DefaultCertificateDeployer(),
      now: () => new Date("2026-01-01T00:00:00Z"),
    });

    // Seed a certificate that is already due for renewal.
    const seeded: Stored = {
      id: "cert_due",
      domains: ["example.com"],
      issuer: "Delego Local CA",
      serialNumber: "old",
      notBefore: new Date("2025-01-01").toISOString(),
      notAfter: new Date("2025-02-01").toISOString(),
      status: "expired",
      autoRenew: true,
      nextRenewalAt: new Date("2025-12-01").toISOString(),
      certificatePem: "OLD",
      fullchainPem: "OLD",
      privateKeyPem: "OLD",
      config: { ...baseConfig, renewBeforeDays: 30 },
      ctLogs: [],
    };
    await store.save(seeded);

    const summary = await service.renewDueCertificates(new Date("2026-01-15T00:00:00Z"));
    expect(summary.checked).toBe(1);
    expect(summary.renewed).toBe(0);
    expect(summary.failed).toBe(1);
    expect(summary.errors[0].id).toBe("cert_due");

    const metrics = await service.metrics();
    expect(metrics.failedRenewals).toBe(1);
    expect(metrics.renewalSuccessRate).toBe(0);

    // Direct renewal also surfaces the underlying error.
    await expect(service.renew("cert_due")).rejects.toThrow(/rate limited/);
  });

  it("does not renew revoked certificates", async () => {
    const store = new InMemoryCertificateStore();
    const service = makeService(new StubAcmeClient(), store);
    const cert = await service.issue(baseConfig);
    await service.revoke(cert.id);
    const summary = await service.renewDueCertificates(new Date("2026-06-01T00:00:00Z"));
    expect(summary.checked).toBe(0);
  });
});

describe("CertificateService revocation", () => {
  it("marks a certificate revoked", async () => {
    const service = makeService();
    const cert = await service.issue(baseConfig);
    const revoked = await service.revoke(cert.id);
    expect(revoked.status).toBe("revoked");
    const inventory = await service.inventory();
    expect(inventory[0].status).toBe("revoked");
  });
});
