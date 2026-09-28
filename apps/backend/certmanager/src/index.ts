/**
 * @delegolabs/certmanager — Automated TLS certificate management.
 *
 * Responsibilities:
 *   - ACME issuance (Let's Encrypt, ZeroSSL, Buypass, custom)
 *   - Automatic renewal before expiry
 *   - Certificate Transparency log submission
 *   - Certificate inventory + monitoring/metrics
 *   - Wildcard certificate support (dns-01)
 *   - Certificate revocation
 *   - Deployment automation (nginx/haproxy/envoy/webhook)
 *   - Merchant storefront SSL/TLS expiry monitoring (Issue #390)
 */
import { createLogger, createHealthRoutes, startHttpServer, HealthRegistry } from "@delegolabs/utils";
import { createAcmeClient } from "./acme/client.js";
import { createCertificateStore } from "./store/certificateStore.js";
import { createCtLogSubmitter } from "./ct/ctLog.js";
import { createDeployer } from "./deploy/deployer.js";
import { CertificateService } from "./service.js";
import { RenewalScheduler } from "./renewal/scheduler.js";
import { registerRoutes } from "./routes/index.js";
import { registerCertExpiryRoutes } from "./routes/certExpiryRoutes.js";
import { CertExpiryChecker } from "./expiry/checker.js";
import { ExpiryScheduler } from "./expiry/scheduler.js";
import { createCertExpiryAlerter } from "./expiry/alerter.js";

const SERVICE_NAME = "certmanager";
const DEFAULT_PORT = 3020;

const nodeEnv = process.env.NODE_ENV ?? "development";
const logLevel = process.env.LOG_LEVEL ?? "info";
const port = Number(process.env.CERTMANAGER_PORT ?? DEFAULT_PORT);
const log = createLogger(SERVICE_NAME, logLevel);

const store = createCertificateStore();
const ctSubmitter = createCtLogSubmitter({
  enabled: process.env.CERT_CT_ENABLED !== "false",
  logUrls: (process.env.CERT_CT_LOG_URLS ?? "https://ct.googleapis.com/logs/argon2024,https://ct.cloudflare.com/logs/nimbus2024")
    .split(",")
    .filter(Boolean),
});
const deployer = createDeployer();
const service = new CertificateService({ store, ctSubmitter, deployer });

const scheduler = new RenewalScheduler(service, {
  intervalMs: Number(process.env.CERT_RENEWAL_INTERVAL_MS ?? 1000 * 60 * 60 * 12),
  onError: (err) => log.error("renewal tick failed", { error: (err as Error).message }),
});

// Warm the ACME client factory so misconfiguration fails fast at boot.
if (process.env.CERT_ACME_PROVIDER) {
  createAcmeClient({
    provider: process.env.CERT_ACME_PROVIDER as any,
    accountKey: process.env.CERT_ACME_ACCOUNT_KEY ?? "",
    mode: process.env.CERT_ACME_MODE as any,
  });
}

const healthRegistry = new HealthRegistry();
healthRegistry.register(
  "store",
  async () => {
    await store.list();
    return { status: "healthy" };
  },
  { type: "custom", critical: true },
);
const health = createHealthRoutes({
  registry: healthRegistry,
  serviceName: SERVICE_NAME,
  version: "0.0.1",
});

// Issue #390 — automated SSL/TLS certificate expiry checking for merchant
// storefronts: probe each registered custom domain and alert 14 days before
// expiration.
const expiryChecker = new CertExpiryChecker({
  alerter: createCertExpiryAlerter({
    webhookUrl: process.env.CERT_EXPIRY_WEBHOOK_URL,
  }),
  warningDays: Number(process.env.CERT_EXPIRY_WARNING_DAYS ?? 14),
  probe: {
    timeoutMs: Number(process.env.CERT_EXPIRY_PROBE_TIMEOUT_MS ?? 10_000),
    port: Number(process.env.CERT_EXPIRY_PROBE_PORT ?? 443),
  },
});

// Seed monitored domains from a JSON env var:
//   [{ "merchantId": "m1", "domain": "shop.example.com" }, ...]
try {
  if (process.env.CERT_EXPIRY_DOMAINS) {
    expiryChecker.registerDomains(JSON.parse(process.env.CERT_EXPIRY_DOMAINS));
    log.info("registered merchant domains for expiry monitoring", {
      count: expiryChecker.listDomains().length,
    });
  }
} catch (err) {
  log.error("invalid CERT_EXPIRY_DOMAINS payload — expiry monitoring starts empty", {
    error: (err as Error).message,
  });
}

const expiryScheduler = new ExpiryScheduler(expiryChecker, {
  intervalMs: Number(process.env.CERT_EXPIRY_INTERVAL_MS ?? 1000 * 60 * 60 * 12),
  onError: (err) => log.error("expiry check tick failed", { error: (err as Error).message }),
});

log.info("Starting certmanager", { port, nodeEnv });

startHttpServer({
  port,
  serviceName: SERVICE_NAME,
  version: "0.0.1",
  routes: [...health, ...registerRoutes(service), ...registerCertExpiryRoutes(expiryChecker)],
});

if (process.env.CERT_RENEWAL_ENABLED !== "false") {
  scheduler.start();
}

if (process.env.CERT_EXPIRY_ENABLED !== "false") {
  expiryScheduler.start();
}

export { service, scheduler, expiryChecker, expiryScheduler };
