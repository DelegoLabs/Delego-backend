import { createHash } from 'node:crypto';

export interface EncryptedAddressSchemaAuditInput {
  referenceId: string;
  encryptedFieldCount: number;
  kmsKeyRotationAgeDays: number;
  plaintextLeakCount: number;
  thresholdLimit?: number;
}

export interface EncryptedAddressSchemaAudit {
  referenceId: string;
  encryptedFieldCount: number;
  kmsKeyRotationAgeDays: number;
  plaintextLeakCount: number;
  utilizationBps: number;
  status: 'healthy' | 'degraded' | 'halted';
  summary: string;
  checksumHex: string;
}

export function auditBuyerEncryptedPiiSchema(input: EncryptedAddressSchemaAuditInput): EncryptedAddressSchemaAudit {
  const referenceId = input.referenceId.trim();
  if (!referenceId) {
    throw new Error('auditBuyerEncryptedPiiSchema: referenceId is required');
  }
  if (
    !Number.isFinite(input.encryptedFieldCount) ||
    !Number.isFinite(input.kmsKeyRotationAgeDays) ||
    !Number.isFinite(input.plaintextLeakCount)
  ) {
    throw new Error('auditBuyerEncryptedPiiSchema: numeric inputs must be finite');
  }

  const v1 = Math.max(0, Math.trunc(input.encryptedFieldCount));
  const v2 = Math.max(0, Math.trunc(input.kmsKeyRotationAgeDays));
  const v3 = Math.max(0, Math.trunc(input.plaintextLeakCount));
  const limit = Math.max(1, Math.trunc(input.thresholdLimit ?? 1000));

  const utilizationBps = Math.min(10000, Math.round(((v1 + v2) * 10000) / limit));
  let status: 'healthy' | 'degraded' | 'halted' = 'healthy';
  let summary = `nominal (encryptedFieldCount=${v1}, kmsKeyRotationAgeDays=${v2}, plaintextLeakCount=${v3})`;

  if (v3 > limit || utilizationBps >= 9000) {
    status = 'halted';
    summary = `limit exceeded: utilization=${utilizationBps}bps, plaintextLeakCount=${v3} > ${limit}`;
  } else if (utilizationBps >= 5000) {
    status = 'degraded';
    summary = `elevated utilization=${utilizationBps}bps for ${referenceId}`;
  }

  const canonical = JSON.stringify({
    referenceId,
    encryptedFieldCount: v1,
    kmsKeyRotationAgeDays: v2,
    plaintextLeakCount: v3,
    utilizationBps,
    status,
    summary,
  });
  const checksumHex = createHash('sha256').update(canonical).digest('hex');

  return {
    referenceId,
    encryptedFieldCount: v1,
    kmsKeyRotationAgeDays: v2,
    plaintextLeakCount: v3,
    utilizationBps,
    status,
    summary,
    checksumHex,
  };
}
