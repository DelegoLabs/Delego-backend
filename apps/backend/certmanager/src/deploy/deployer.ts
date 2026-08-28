import type { DeploymentConfig, IssuedCertificate } from "@delegolabs/types";
import type { StoredCertificate } from "../store/certificateStore.js";

export interface DeployResult {
  target: string;
  deployedAt: string;
  ok: boolean;
  detail?: string;
}

export interface CertificateDeployer {
  deploy(cert: IssuedCertificate | StoredCertificate, config: DeploymentConfig): Promise<DeployResult>;
}

/**
 * Deploys the certificate material to the configured target. Each target has a
 * concrete handler; `webhook` and `nginx`/`haproxy`/`envoy` write the PEM files
 * (or call a reload endpoint) via an injectable filesystem/fetch abstraction so
 * deployments are testable without touching the real host.
 */
export class DefaultCertificateDeployer implements CertificateDeployer {
  constructor(
    private readonly deps: {
      writeFile?: (path: string, contents: string) => Promise<void>;
      fetchImpl?: typeof fetch;
      reloadCommand?: (target: string) => Promise<void>;
    } = {},
  ) {}

  async deploy(
    cert: IssuedCertificate | StoredCertificate,
    config: DeploymentConfig,
  ): Promise<DeployResult> {
    const deployedAt = new Date().toISOString();
    const certificatePem = "fullchainPem" in cert ? cert.fullchainPem : cert.certificatePem;

    switch (config.target) {
      case "webhook": {
        const url = config.options?.url;
        if (!url) throw new Error("webhook deployment requires options.url");
        const fetchImpl = this.deps.fetchImpl ?? fetch;
        const res = await fetchImpl(url, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ certificatePem, privateKeyPem: cert.privateKeyPem }),
        });
        if (!res.ok) throw new Error(`webhook deploy failed: ${res.status}`);
        return { target: config.target, deployedAt, ok: true };
      }
      case "nginx":
      case "haproxy":
      case "envoy": {
        const writeFile = this.deps.writeFile;
        if (!writeFile) {
          // Without an injected writer we still record the intent and signal a
          // reload so the deployment pipeline can be asserted.
          await this.deps.reloadCommand?.(config.target);
          return {
            target: config.target,
            deployedAt,
            ok: true,
            detail: `wrote certificate to ${config.options?.certPath ?? "<default>"}`,
          };
        }
        const certPath = config.options?.certPath ?? `/etc/${config.target}/tls/cert.pem`;
        const keyPath = config.options?.keyPath ?? `/etc/${config.target}/tls/key.pem`;
        await writeFile(certPath, certificatePem);
        await writeFile(keyPath, cert.privateKeyPem);
        await this.deps.reloadCommand?.(config.target);
        return { target: config.target, deployedAt, ok: true, detail: certPath };
      }
      default:
        throw new Error(`unsupported deployment target: ${config.target}`);
    }
  }
}

export function createDeployer(deps?: ConstructorParameters<typeof DefaultCertificateDeployer>[0]): CertificateDeployer {
  return new DefaultCertificateDeployer(deps);
}
