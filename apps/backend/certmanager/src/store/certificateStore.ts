import type { Certificate, CertificateConfig } from "@delegolabs/types";

export interface StoredCertificate extends Certificate {
  certificatePem: string;
  fullchainPem: string;
  privateKeyPem: string;
  config: CertificateConfig;
  ctLogs: Array<{ logUrl: string; submittedAt: string; sct?: string }>;
}

export interface CertificateStore {
  save(cert: StoredCertificate): Promise<void>;
  get(id: string): Promise<StoredCertificate | undefined>;
  list(): Promise<StoredCertificate[]>;
  delete(id: string): Promise<void>;
  findByDomains(domains: string[]): Promise<StoredCertificate | undefined>;
}

export class InMemoryCertificateStore implements CertificateStore {
  private readonly certs = new Map<string, StoredCertificate>();

  async save(cert: StoredCertificate): Promise<void> {
    this.certs.set(cert.id, cert);
  }

  async get(id: string): Promise<StoredCertificate | undefined> {
    return this.certs.get(id);
  }

  async list(): Promise<StoredCertificate[]> {
    return [...this.certs.values()];
  }

  async delete(id: string): Promise<void> {
    this.certs.delete(id);
  }

  async findByDomains(domains: string[]): Promise<StoredCertificate | undefined> {
    const key = [...domains].sort().join(",");
    return [...this.certs.values()].find(
      (c) => [...c.domains].sort().join(",") === key,
    );
  }
}

/**
 * PostgreSQL-backed store. Used when CERT_STORE=postgres. The in-memory store
 * is the default so the service and tests run without a database.
 */
export class PostgresCertificateStore implements CertificateStore {
  constructor(private readonly sequelize: any) {}

  async save(cert: StoredCertificate): Promise<void> {
    await this.sequelize.query(
      `INSERT INTO certificates (id, data) VALUES (:id, :data)
       ON CONFLICT (id) DO UPDATE SET data = :data`,
      {
        replacements: {
          id: cert.id,
          data: JSON.stringify(cert),
        },
      },
    );
  }

  async get(id: string): Promise<StoredCertificate | undefined> {
    const [rows] = await this.sequelize.query(
      "SELECT data FROM certificates WHERE id = :id",
      { replacements: { id } },
    );
    const row = (rows as Array<{ data: string }>)[0];
    return row ? (JSON.parse(row.data) as StoredCertificate) : undefined;
  }

  async list(): Promise<StoredCertificate[]> {
    const [rows] = await this.sequelize.query("SELECT data FROM certificates");
    return (rows as Array<{ data: string }>).map((r) => JSON.parse(r.data));
  }

  async delete(id: string): Promise<void> {
    await this.sequelize.query("DELETE FROM certificates WHERE id = :id", {
      replacements: { id },
    });
  }

  async findByDomains(domains: string[]): Promise<StoredCertificate | undefined> {
    const all = await this.list();
    const key = [...domains].sort().join(",");
    return all.find((c) => [...c.domains].sort().join(",") === key);
  }

  async ensureSchema(): Promise<void> {
    await this.sequelize.query(
      "CREATE TABLE IF NOT EXISTS certificates (id TEXT PRIMARY KEY, data JSONB NOT NULL)",
    );
  }
}

export function createCertificateStore(sequelize?: any): CertificateStore {
  if (sequelize && process.env.CERT_STORE === "postgres") {
    return new PostgresCertificateStore(sequelize);
  }
  return new InMemoryCertificateStore();
}
