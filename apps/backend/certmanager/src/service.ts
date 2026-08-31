import { createLogger } from "@delegolabs/utils";
import type {
  Certificate,
  CertificateConfig,
  CertificateMetrics,
  DeploymentConfig,
  RevocationReason,
} from "@delegolabs/types";
import {
  type AcmeClient,
  type IssueInput,
  type RevocationReason as AcmeRevocationReason,
  createAcmeClient,
  validateWildcardSupport,
} from "./acme/client.js";
import { createDnsProvider, type DnsProvider } from "./acme/dns.js";
import type { AcmeChallenge } from "./acme/types.js";
import type { CertificateStore, StoredCertificate } from "./store/certificateStore.js";
import type { CtLogSubmitter } from "./ct/ctLog.js";
import type { CertificateDeployer } from "./deploy/deployer.js";
import { RenewalTracker, computeMetrics } from "./monitor/metrics.js";
import { generateId } from "./crypto.js";

export interface CertificateServiceDeps {
  store: CertificateStore;
  acmeClient?: AcmeClient;
  ctSubmitter: CtLogSubmitter;
  deployer: CertificateDeployer;
  tracker?: RenewalTracker;
  /** How many days before expiry a cert is considered "expiring" / due for renewal. */
  expiringSoonDays?: number;
  /** Overrides DNS provider creation (used to inject test doubles). */
  dnsProviderFactory?: (config: any) => DnsProvider | undefined;
  now?: () => Date;
  log?: ReturnType<typeof createLogger>;
}

export interface RenewalSummary {
  checked: number;
  renewed: number;
  failed: number;
  errors: Array<{ id: string; error: string }>;
}

export interface IssueOptions {
  deployment?: DeploymentConfig;
  autoRenew?: boolean;
}

export class CertificateService {
  private readonly store: CertificateStore;
  private readonly acmeClient?: AcmeClient;
  private readonly ctSubmitter: CtLogSubmitter;
  private readonly deployer: CertificateDeployer;
  private readonly tracker: RenewalTracker;
  private readonly expiringSoonDays: number;
  private readonly now: () => Date;
  private readonly log: ReturnType<typeof createLogger>;
  private readonly dnsProviderFactory?: (config: any) => DnsProvider | undefined;

  constructor(deps: CertificateServiceDeps) {
    this.store = deps.store;
    this.acmeClient = deps.acmeClient;
    this.ctSubmitter = deps.ctSubmitter;
    this.deployer = deps.deployer;
    this.tracker = deps.tracker ?? new RenewalTracker();
    this.expiringSoonDays = deps.expiringSoonDays ?? 30;
    this.now = deps.now ?? (() => new Date());
    this.log = deps.log ?? createLogger("certmanager");
    this.dnsProviderFactory = deps.dnsProviderFactory;
  }

  /** Issues a new certificate for the given configuration. */
  async issue(config: CertificateConfig, options: IssueOptions = {}): Promise<Certificate> {
    validateWildcardSupport(config.domains, config.challengeType, config.wildcardEnabled);

    const acme = this.acmeClient ?? createAcmeClient({
      provider: config.acmeProvider,
      accountKey: config.acmeAccountKey,
      customDirectoryUrl: process.env.CUSTOM_ACME_DIRECTORY_URL,
    });

    const dns = this.resolveDns(config);
    const start = this.now().getTime();

    const input = this.buildIssueInput(config, dns);
    const issued = await acme.issue(input);

    const notAfter = new Date(issued.notAfter);
    const stored = await this.persist({
      id: generateId(),
      domains: config.domains,
      issuer: issued.issuer,
      serialNumber: issued.serialNumber,
      notBefore: issued.notBefore,
      notAfter: issued.notAfter,
      status: "valid",
      autoRenew: options.autoRenew ?? true,
      nextRenewalAt: this.nextRenewalAt(notAfter, config.renewBeforeDays),
      certificatePem: issued.certificatePem,
      fullchainPem: issued.fullchainPem,
      privateKeyPem: issued.privateKeyPem,
      config,
      ctLogs: [],
    });

    await this.submitCt(stored, issued);
    if (options.deployment) {
      await this.deployer.deploy(stored, options.deployment);
    }

    const durationMs = this.now().getTime() - start;
    this.tracker.record({ certId: stored.id, success: true, durationMs, at: this.now().toISOString() });

    this.log.info("issued certificate", { id: stored.id, domains: config.domains });
    return this.toCertificate(stored);
  }

  /** Renews a specific certificate using its stored configuration. */
  async renew(id: string): Promise<Certificate> {
    const existing = await this.store.get(id);
    if (!existing) throw new Error(`certificate not found: ${id}`);
    if (existing.status === "revoked") throw new Error("cannot renew a revoked certificate");

    const config = existing.config;
    const acme = this.acmeClient ?? createAcmeClient({
      provider: config.acmeProvider,
      accountKey: config.acmeAccountKey,
    });
    const dns = this.resolveDns(config);
    const start = this.now().getTime();

    try {
      const input = this.buildIssueInput(config, dns);
      const issued = await acme.issue(input);
      const stored = await this.persist(
        { ...existing, status: "valid", privateKeyPem: issued.privateKeyPem, lastRenewalAttempt: this.now().toISOString(), nextRenewalAt: this.nextRenewalAt(new Date(issued.notAfter), config.renewBeforeDays) },
      );
      await this.submitCt(stored, issued);
      const durationMs = this.now().getTime() - start;
      this.tracker.record({ certId: id, success: true, durationMs, at: this.now().toISOString() });
      this.log.info("renewed certificate", { id });
      return this.toCertificate(stored);
    } catch (err) {
      const durationMs = this.now().getTime() - start;
      this.tracker.record({ certId: id, success: false, durationMs, at: this.now().toISOString() });
      // Keep the old cert but mark it as still expiring/expired so monitoring surfaces it.
      this.log.error("renewal failed", { id, error: (err as Error).message });
      throw err;
    }
  }

  /** Renews every certificate whose auto-renew window has been reached. */
  async renewDueCertificates(now: Date = this.now()): Promise<RenewalSummary> {
    const certs = await this.store.list();
    const summary: RenewalSummary = { checked: 0, renewed: 0, failed: 0, errors: [] };
    for (const cert of certs) {
      if (!cert.autoRenew || cert.status === "revoked") continue;
      if (new Date(cert.nextRenewalAt) > now) continue;
      summary.checked++;
      try {
        await this.renew(cert.id);
        summary.renewed++;
      } catch (err) {
        summary.failed++;
        summary.errors.push({ id: cert.id, error: (err as Error).message });
      }
    }
    return summary;
  }

  /** Revokes a certificate and records the revocation status. */
  async revoke(id: string, reason: RevocationReason = "unspecified"): Promise<Certificate> {
    const existing = await this.store.get(id);
    if (!existing) throw new Error(`certificate not found: ${id}`);
    const acme = this.acmeClient ?? createAcmeClient({
      provider: existing.config.acmeProvider,
      accountKey: existing.config.acmeAccountKey,
    });
    await acme.revoke(existing.serialNumber, reason as AcmeRevocationReason);
    const updated: StoredCertificate = { ...existing, status: "revoked" };
    await this.store.save(updated);
    this.log.info("revoked certificate", { id });
    return this.toCertificate(updated);
  }

  /** Returns the live inventory with recomputed status. */
  async inventory(): Promise<Certificate[]> {
    const certs = await this.store.list();
    return certs.map((c) => this.toCertificate(c));
  }

  async get(id: string): Promise<Certificate | undefined> {
    const cert = await this.store.get(id);
    return cert ? this.toCertificate(cert) : undefined;
  }

  async metrics(): Promise<CertificateMetrics> {
    return computeMetrics(this.store, this.tracker);
  }

  private resolveDns(config: CertificateConfig): DnsProvider | undefined {
    if (config.challengeType === "dns-01") {
      if (!config.dnsProvider) {
        throw new Error("dns-01 challenge requires a dnsProvider configuration");
      }
      if (this.dnsProviderFactory) return this.dnsProviderFactory(config.dnsProvider);
      return createDnsProvider(config.dnsProvider);
    }
    return undefined;
  }

  private buildIssueInput(
    config: CertificateConfig,
    dns?: DnsProvider,
  ): IssueInput {
    return {
      domains: config.domains,
      challengeType: config.challengeType,
      wildcardEnabled: config.wildcardEnabled,
      present: async (challenge: AcmeChallenge) => {
        await dns?.present(challenge);
      },
      cleanup: async (challenge: AcmeChallenge) => {
        await dns?.cleanup(challenge);
      },
    };
  }

  private async persist(base: StoredCertificate): Promise<StoredCertificate> {
    const stored: StoredCertificate = {
      ...base,
      ctLogs: base.ctLogs ?? [],
    };
    await this.store.save(stored);
    return stored;
  }

  private async submitCt(stored: StoredCertificate, issued: { certificatePem: string }): Promise<void> {
    const result = await this.ctSubmitter.submit({
      domains: stored.domains,
      certificatePem: issued.certificatePem,
      privateKeyPem: stored.privateKeyPem,
      issuer: stored.issuer,
      serialNumber: stored.serialNumber,
      notBefore: stored.notBefore,
      notAfter: stored.notAfter,
    });
    stored.ctLogs = result;
    await this.store.save(stored);
  }

  private nextRenewalAt(notAfter: Date, renewBeforeDays: number): string {
    const ms = renewBeforeDays * 24 * 60 * 60 * 1000;
    return new Date(notAfter.getTime() - ms).toISOString();
  }

  private toCertificate(stored: StoredCertificate): Certificate {
    const now = this.now();
    const status = this.computeStatus(stored, now);
    return {
      id: stored.id,
      domains: stored.domains,
      issuer: stored.issuer,
      serialNumber: stored.serialNumber,
      notBefore: stored.notBefore,
      notAfter: stored.notAfter,
      status,
      autoRenew: stored.autoRenew,
      lastRenewalAttempt: stored.lastRenewalAttempt,
      nextRenewalAt: stored.nextRenewalAt,
    };
  }

  private computeStatus(stored: StoredCertificate, now: Date): Certificate["status"] {
    if (stored.status === "revoked" || stored.status === "pending") return stored.status;
    const notAfter = new Date(stored.notAfter).getTime();
    if (notAfter <= now.getTime()) return "expired";
    const expiringThreshold = (this.expiringSoonDays) * 24 * 60 * 60 * 1000;
    if (notAfter - now.getTime() <= expiringThreshold) return "expiring";
    return "valid";
  }
}
