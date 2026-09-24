/**
 * Key rotation with dual encryption (#68).
 *
 * Rotation is zero-downtime by design:
 *  1. `beginRotation` mints a fresh data key at `nextVersion = current + 1`
 *     and persists its wrapped copy, recording metadata into the
 *     `encryption_key_versions` table (migration 038) via a supplied store.
 *  2. Old rows still reference the previous key version — decryption simply
 *     resolves that version's data key (the provider's wrapped-key store
 *     keeps the previous version available for reading).
 *  3. `reEncrypt` uses *dual encryption*: each value is first decrypted with
 *     its old key version and immediately re-encrypted with the new active
 *     version, then written back under `keyVersion = nextVersion`. During a
 *     rotation window both versions are valid (dual encryption), so there is
 *     no lockstep between a value's write and read.
 *  4. `completeRotation` retires the previous version once re-encryption
 *     confirms no values reference it.
 */

import type { EncryptedField, KeyRotationStatus } from "@delegolabs/types";
import { encryptField, decryptField, EncryptionError } from "./cipher.js";
import type { KeyProvider, DataKey } from "./keyProvider.js";
import type { KeyAccessAuditor } from "./audit.js";

export interface EncryptionKeyVersionRow {
  keyId: string;
  version: number;
  keyProvider: "aws_kms" | "vault" | "local";
  wrappedKey: string;
  activatedAt: string;
  status: "active" | "previous" | "retired";
}

export interface EncryptionKeyVersionStore {
  insert(row: EncryptionKeyVersionRow): Promise<void>;
  get(keyId: string, version: number): Promise<EncryptionKeyVersionRow | undefined>;
  list(keyId: string): Promise<EncryptionKeyVersionRow[]>;
  updateStatus(keyId: string, version: number, status: EncryptionKeyVersionRow["status"]): Promise<void>;
}

export class InMemoryEncryptionKeyVersionStore implements EncryptionKeyVersionStore {
  private rows: EncryptionKeyVersionRow[] = [];

  async insert(row: EncryptionKeyVersionRow): Promise<void> {
    this.rows.push({ ...row });
  }
  async get(keyId: string, version: number): Promise<EncryptionKeyVersionRow | undefined> {
    return this.rows.find((r) => r.keyId === keyId && r.version === version);
  }
  async list(keyId: string): Promise<EncryptionKeyVersionRow[]> {
    return this.rows.filter((r) => r.keyId === keyId).sort((a, b) => a.version - b.version);
  }
  async updateStatus(keyId: string, version: number, status: EncryptionKeyVersionRow["status"]): Promise<void> {
    const row = this.rows.find((r) => r.keyId === keyId && r.version === version);
    if (row) row.status = status;
  }
  clear(): void {
    this.rows = [];
  }
}

export interface KeyRotationManagerOptions {
  keyProvider: KeyProvider;
  /** Version store persisting rotation metadata (Postgres-backed in production). */
  versionStore?: EncryptionKeyVersionStore;
  audit?: KeyAccessAuditor;
  /** Rotation cadence in days — drives `status().nextRotationAt`. */
  rotationDays?: number;
  keyIdOverride?: string;
}

export interface ReEncryptTarget {
  /**
   * Read current stored ciphertext for the value. Returns null when the
   * value is already on the target version (or, at `dryRun`, as a scan).
   */
  read(): Promise<{ field: EncryptedField; context?: Record<string, string> } | null>;
  /** Persist the re-encrypted value under the new key version. */
  write(field: EncryptedField): Promise<void>;
}

export interface ReEncryptResult {
  scanned: number;
  rotated: number;
  skipped: number;
}

/**
 * In-place dual-encryption of a stored value during rotation: decrypts with
 * the value's current keyVersion and re-encrypts under the target version.
 */
export async function dualEncryptField(
  field: EncryptedField,
  oldDataKey: DataKey,
  newDataKey: DataKey,
  algorithm: "AES-256-GCM" | "AES-256-CBC",
  context: Record<string, string> = {},
  targetVersion: number
): Promise<EncryptedField> {
  try {
    const plaintext = decryptField(field, oldDataKey.key, context);
    const reEncrypted = encryptField(plaintext, newDataKey.key, algorithm, context);
    return { ...reEncrypted, keyVersion: targetVersion };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    throw new EncryptionError(`dualEncryptField failed (v${field.keyVersion} → v${targetVersion}): ${message}`);
  }
}

export class KeyRotationManager {
  private readonly keyProvider: KeyProvider;
  private readonly versionStore: EncryptionKeyVersionStore;
  private readonly audit?: KeyAccessAuditor;
  private readonly rotationDays: number;
  private readonly keyId: string;
  private rotationInProgressFlag = false;

  constructor(options: KeyRotationManagerOptions) {
    this.keyProvider = options.keyProvider;
    this.versionStore = options.versionStore ?? new InMemoryEncryptionKeyVersionStore();
    this.audit = options.audit;
    this.rotationDays = options.rotationDays && options.rotationDays > 0 ? options.rotationDays : 90;
    this.keyId = options.keyIdOverride ?? this.keyProvider.keyId;
  }

  get rotationInProgress(): boolean {
    return this.rotationInProgressFlag;
  }

  private async currentVersion(): Promise<number> {
    const versions = await this.versionStore.list(this.keyId);
    if (versions.length === 0) return 1;
    return Math.max(...versions.map((v) => v.version));
  }

  /** Highest version the provider can currently read (previous + active). */
  private async latestProviderVersion(): Promise<number> {
    const versions = await this.keyProvider.listVersions();
    if (versions.length === 0) return 1;
    return Math.max(...versions);
  }

  /** Persist rotation metadata for a freshly minted key version. */
  async recordVersion(version: number, dataKey: DataKey): Promise<void> {
    await this.versionStore.insert({
      keyId: this.keyId,
      version,
      keyProvider: this.keyProvider.name,
      wrappedKey: dataKey.wrappedKey,
      activatedAt: new Date().toISOString(),
      status: "active",
    });
  }

  /**
   * Start a rotation: mint the next data key version and mark the previous
   * version as `previous` (still decryptable — dual encryption window).
   */
  async beginRotation(): Promise<{ nextVersion: number; status: KeyRotationStatus }> {
    if (this.rotationInProgressFlag) {
      throw new EncryptionError("A key rotation is already in progress");
    }

    const current = await this.currentVersion();
    const nextVersion = current + 1;

    const dataKey = await this.keyProvider.generateDataKey(nextVersion);
    await this.recordVersion(nextVersion, dataKey);

    // New writes now target the new key; old rows still read fine.
    this.keyProvider.setActiveVersion?.(nextVersion);

    const updated = await this.versionStore.list(this.keyId);
    for (const row of updated) {
      if (row.version < nextVersion && row.status !== "previous") {
        await this.versionStore.updateStatus(this.keyId, row.version, "previous");
      }
    }

    this.rotationInProgressFlag = true;
    await this.audit?.record({
      operation: "rotate",
      keyId: this.keyId,
      keyVersion: nextVersion,
      table: "*",
      column: "*",
      context: { action: "beginRotation" },
      actorRole: "system",
      success: true,
    });

    return { nextVersion, status: await this.status() };
  }

  /**
   * Re-encrypt one stored value onto the active version using dual
   * encryption. Returns true when the value had to move versions.
   */
  async reEncryptValue(
    target: ReEncryptTarget,
    context: Record<string, string> = {}
  ): Promise<boolean> {
    const active = await this.latestProviderVersion();
    const stored = await target.read();
    if (!stored) return false;

    if (stored.field.keyVersion === active) return false;

    const oldDataKey = await this.keyProvider.getDataKey(stored.field.keyVersion);
    const newDataKey = await this.keyProvider.getDataKey(active);
    const reEncrypted = await dualEncryptField(
      stored.field,
      oldDataKey,
      newDataKey,
      this.keyProvider.name === "local" ? "AES-256-GCM" : stored.field.algorithm,
      context,
      active
    );
    await target.write(reEncrypted);
    return true;
  }

  /**
   * Sweep a dataset re-encrypting every value still on an old key version.
   *
   * `targets` should be lazy/scanned row-by-row so memory stays bounded on
   * large tables; a Postgres keyset-paged query is the production pattern.
   */
  async reEncryptAll(
    targets: AsyncIterable<ReEncryptTarget>
  ): Promise<ReEncryptResult> {
    const result: ReEncryptResult = { scanned: 0, rotated: 0, skipped: 0 };
    for await (const target of targets) {
      result.scanned += 1;
      const moved = await this.reEncryptValue(target);
      if (moved) result.rotated += 1;
      else result.skipped += 1;
    }
    return result;
  }

  /** Finalize a rotation: retire the previous version(s) once nothing references them. */
  async completeRotation(verifyNoRemaining: () => Promise<number>): Promise<KeyRotationStatus> {
    const remaining = await verifyNoRemaining();
    if (remaining > 0) {
      throw new EncryptionError(
        `Cannot complete rotation: ${remaining} value(s) still reference a previous key version — re-encrypt first`
      );
    }

    const active = await this.currentVersion();
    const versions = await this.versionStore.list(this.keyId);
    for (const row of versions) {
      if (row.version !== active) {
        await this.versionStore.updateStatus(this.keyId, row.version, "retired");
      }
    }

    this.rotationInProgressFlag = false;
    await this.audit?.record({
      operation: "rotate",
      keyId: this.keyId,
      keyVersion: active,
      table: "*",
      column: "*",
      context: { action: "completeRotation" },
      actorRole: "system",
      success: true,
    });
    return this.status();
  }

  /** Cancel an in-flight rotation (roll back the rotation-in-progress flag). */
  async cancelRotation(): Promise<KeyRotationStatus> {
    this.rotationInProgressFlag = false;
    await this.audit?.record({
      operation: "rotate",
      keyId: this.keyId,
      keyVersion: await this.currentVersion(),
      table: "*",
      column: "*",
      context: { action: "cancelRotation" },
      actorRole: "system",
      success: true,
    });
    return this.status();
  }

  /** Issue #68's KeyRotationStatus shape. */
  async status(): Promise<KeyRotationStatus> {
    const versions = await this.versionStore.list(this.keyId);
    const current = versions.length > 0 ? Math.max(...versions.map((v) => v.version)) : 1;
    const previous = versions
      .filter((v) => v.version !== current && v.status === "previous")
      .map((v) => v.version)
      .sort((a, b) => b - a)[0];

    const lastRotated =
      versions.find((v) => v.version === previous)?.activatedAt ??
      versions.find((v) => v.version === current)?.activatedAt;

    const lastDate = lastRotated ? new Date(lastRotated) : new Date();
    const nextRotationAt = new Date(lastDate.getTime() + this.rotationDays * 24 * 60 * 60 * 1000);

    return {
      keyId: this.keyId,
      currentVersion: current,
      ...(previous ? { previousVersion: previous } : {}),
      rotationInProgress: this.rotationInProgressFlag,
      lastRotatedAt: lastRotated ?? lastDate.toISOString(),
      nextRotationAt: nextRotationAt.toISOString(),
    };
  }
}