/**
 * Centralized secrets management configuration types (Issue #97).
 *
 * Scoping note: this defines a provider-agnostic secret-config schema and
 * a validator so a secrets configuration (rotation, access policies, TTLs)
 * can be reviewed and tested before being applied. It intentionally does
 * NOT deploy a Vault cluster or AWS Secrets Manager, issue real dynamic
 * credentials, or configure a CSI driver — choosing Vault vs. a cloud
 * provider's managed service is an infra decision that shouldn't be made
 * unilaterally in this PR.
 */

export type SecretType = "kv" | "database" | "ssh" | "aws" | "gcp" | "azure" | "pki";
export type SecretCapability = "read" | "write" | "delete" | "list" | "update";

export interface SecretPolicy {
  path: string;
  capabilities: SecretCapability[];
}

export interface SecretRotationConfig {
  enabled: boolean;
  /** Cron expression. */
  interval: string;
  script?: string;
}

export interface SecretConfig {
  path: string;
  type: SecretType;
  rotation: SecretRotationConfig;
  policies: SecretPolicy[];
  /** Duration string, e.g. "24h". */
  ttl: string;
  maxVersions: number;
}

export interface DynamicSecret {
  path: string;
  credentials: {
    username: string;
    password: string;
    leaseId: string;
    leaseDuration: number;
    renewable: boolean;
  };
  issuedAt: string;
}

export type SecretOperation = "read" | "write" | "delete" | "list" | "renew" | "revoke";

export interface SecretAuditEntry {
  path: string;
  operation: SecretOperation;
  clientToken: string;
  entityId: string;
  timestamp: string;
  success: boolean;
  error?: string;
}
