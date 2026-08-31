import type { CtLogResult, IssuedCertificate } from "@delegolabs/types";

export interface CtLogSubmitter {
  /** Submits a issued certificate to the configured Certificate Transparency logs. */
  submit(cert: IssuedCertificate): Promise<CtLogResult[]>;
}

/**
 * Submits certificates to RFC 6962 Certificate Transparency logs. In
 * production this POSTs the certificate to each configured log endpoint and
 * captures the returned Signed Certificate Timestamp (SCT). The fetch
 * implementation is injectable so submission can be asserted in tests without
 * network access.
 */
export class HttpCtLogSubmitter implements CtLogSubmitter {
  constructor(
    private readonly logUrls: string[],
    private readonly fetchImpl: typeof fetch = fetch,
  ) {
    if (logUrls.length === 0) {
      throw new Error("at least one CT log URL must be configured");
    }
  }

  async submit(cert: IssuedCertificate): Promise<CtLogResult[]> {
    const results: CtLogResult[] = [];
    for (const logUrl of this.logUrls) {
      const res = await this.fetchImpl(`${logUrl.replace(/\/$/, "")}/ct/v1/add-chain`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ chain: [cert.certificatePem] }),
      });
      const submittedAt = new Date().toISOString();
      if (!res.ok) {
        throw new Error(`CT log submission failed (${logUrl}): ${res.status}`);
      }
      const body = (await res.json()) as { sct?: string };
      results.push({ logUrl, submittedAt, sct: body.sct });
    }
    return results;
  }
}

/**
 * No-op submitter used when CT logging is disabled (CERT_CT_ENABLED=false).
 * Still records the attempt timestamp for audit purposes.
 */
export class NoopCtLogSubmitter implements CtLogSubmitter {
  async submit(_cert: IssuedCertificate): Promise<CtLogResult[]> {
    return [{ logUrl: "noop", submittedAt: new Date().toISOString() }];
  }
}

export function createCtLogSubmitter(options: {
  enabled: boolean;
  logUrls?: string[];
  fetchImpl?: typeof fetch;
}): CtLogSubmitter {
  if (!options.enabled) return new NoopCtLogSubmitter();
  return new HttpCtLogSubmitter(
    options.logUrls ?? (process.env.CERT_CT_LOG_URLS ?? "").split(",").filter(Boolean),
    options.fetchImpl,
  );
}
