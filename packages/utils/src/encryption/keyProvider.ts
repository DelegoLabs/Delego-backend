/**
 * Key providers for column-level PII encryption (#68).
 *
 * All three providers from issue #68's `EncryptionConfig.keyProvider` are
 * supported:
 *
 *  - `local`: 32-byte data keys derived per-version from the
 *    ENCRYPTION_MASTER_KEY[*] environment secrets via HKDF-SHA256. Zero
 *    infrastructure; the baseline every test and dev environment uses.
 *  - `aws_kms`: AWS KMS envelope encryption. `GenerateDataKey` produces a
 *    plaintext data key plus a wrapped (ciphertext) copy; the plaintext is
 *    cached in-process for the <2ms budget while the wrapped copy is
 *    persisted. `Decrypt` unwraps a previous version's data key at read
 *    time — so rotating the KMS master/alias never requires a data rewrite.
 *  - `vault`: HashiCorp Vault Transit engine `datakey/plaintext` endpoint,
 *    which behaves identically to KMS envelope encryption. Wrapped data keys
 *    are persisted alongside.
 *
 * Envelope encryption is what makes zero-downtime key rotation possible:
 * the persisted ciphertext values never change during a key switch — only
 * the data key that encrypts them, and unwrapping is version-addressable.
 */

import * as crypto from "node:crypto";
import { EncryptionError, KEY_LENGTH } from "./cipher.js";

export type KeyProviderName = "local" | "aws_kms" | "vault";

export interface DataKey {
  /** Raw 32-byte AES-256 data key — NEVER persisted, cached in-process only. */
  key: Buffer;
  /** Opaque wrapped copy of the data key (KMS ciphertext / Vault transit ciphertext / local fingerprint). */
  wrappedKey: string;
  keyVersion: number;
  keyId: string;
}

/** Where wrapped data keys live between rotations. */
export interface WrappedKeyStore {
  get(version: number): Promise<string | undefined>;
  set(version: number, wrappedKey: string): Promise<void>;
  list(): Promise<number[]>;
}

export class InMemoryWrappedKeyStore implements WrappedKeyStore {
  private readonly keys = new Map<number, string>();
  async get(version: number): Promise<string | undefined> {
    return this.keys.get(version);
  }
  async set(version: number, wrappedKey: string): Promise<void> {
    this.keys.set(version, wrappedKey);
  }
  async list(): Promise<number[]> {
    return [...this.keys.keys()].sort((a, b) => a - b);
  }
}

export interface KeyProvider {
  readonly name: KeyProviderName;
  readonly keyId: string;
  /** Version new writes should use (the active version). */
  activeVersion(): Promise<number>;
  /** Resolve the raw data key for a version, unwrapping the envelope as needed. */
  getDataKey(version: number): Promise<DataKey>;
  /** Mint a fresh data key under `version` and persist its wrapped copy. */
  generateDataKey(version: number): Promise<DataKey>;
  /** All versions the provider currently knows about. */
  listVersions(): Promise<number[]>;
  /**
   * Promote `version` to the active (write) version. Called by the rotation
   * manager when a rotation begins so new writes land on the new key.
   */
  setActiveVersion?(version: number): void;
}

// ─── shared helpers ──────────────────────────────────────────────────────────

function requireKeyBytes(value: Buffer): Buffer {
  if (!value || value.length !== KEY_LENGTH) {
    throw new EncryptionError(`Provider returned an invalid data key (expected ${KEY_LENGTH} bytes)`);
  }
  return value;
}

/** HKDF-SHA256 derivation of a 32-byte data key from a master secret + version. */
function deriveLocalDataKey(masterSecret: string, version: number, keyId: string): Buffer {
  const ikm = crypto.createHash("sha256").update(masterSecret, "utf8").digest();
  const info = Buffer.from(`delego:pii:${keyId}:v${version}`, "utf8");
  return requireKeyBytes(
    Buffer.from(crypto.hkdfSync("sha256", ikm, Buffer.alloc(0), info, KEY_LENGTH))
  );
}

function localKeyFingerprint(key: Buffer): string {
  return crypto.createHash("sha256").update(key).digest("hex");
}

/**
 * Local provider — HKDF-derived per-version keys from
 * ENCRYPTION_MASTER_KEY / ENCRYPTION_MASTER_KEY_V<n>. The base
 * ENCRYPTION_MASTER_KEY always maps to version 1.
 */
export class LocalKeyProvider implements KeyProvider {
  readonly name = "local" as const;
  readonly keyId: string;
  private readonly cache = new Map<number, DataKey>();
  private readonly masterSecrets: Map<number, string>;
  private active: number;

  constructor(config: { keyId?: string; activeVersion?: number; secrets?: Record<number, string> } = {}) {
    this.keyId = config.keyId ?? "local";
    this.active = config.activeVersion && config.activeVersion >= 1 ? config.activeVersion : 1;
    this.masterSecrets = new Map();

    if (config.secrets && Object.keys(config.secrets).length > 0) {
      for (const [version, secret] of Object.entries(config.secrets)) {
        this.masterSecrets.set(Number(version), secret);
      }
    } else {
      const base = process.env.ENCRYPTION_MASTER_KEY;
      const versions = [...new Set([1, this.active])];
      for (const version of versions) {
        const secret = version === 1
          ? base
          : process.env[`ENCRYPTION_MASTER_KEY_V${version}`] ?? base;
        if (!secret) continue;
        this.masterSecrets.set(version, secret);
      }
    }

    for (const [version, secret] of this.masterSecrets) {
      if (secret.length < 16) {
        throw new EncryptionError(
          `ENCRYPTION_MASTER_KEY for version ${version} must be at least 16 characters`
        );
      }
    }

    if (!this.masterSecrets.has(this.active)) {
      this.masterSecrets.set(
        this.active,
        this.masterSecrets.get(1) ?? defaultMasterSecret()
      );
    }
  }

  async activeVersion(): Promise<number> {
    return this.active;
  }

  async getDataKey(version: number): Promise<DataKey> {
    this.assertKnownVersion(version);
    if (this.cache.has(version)) return this.cache.get(version)!;
    const key = deriveLocalDataKey(this.masterSecrets.get(version)!, version, this.keyId);
    const dataKey: DataKey = {
      key,
      wrappedKey: localKeyFingerprint(key),
      keyVersion: version,
      keyId: this.keyId,
    };
    this.cache.set(version, dataKey);
    return dataKey;
  }

  async generateDataKey(version: number): Promise<DataKey> {
    if (version < 1) throw new EncryptionError("key version must be >= 1");
    if (!this.masterSecrets.has(version)) {
      throw new EncryptionError(`No master secret configured for version ${version}`);
    }
    return this.getDataKey(version);
  }

  async listVersions(): Promise<number[]> {
    return [...this.masterSecrets.keys()].sort((a, b) => a - b);
  }

  setActiveVersion(version: number): void {
    if (version < 1) throw new EncryptionError("key version must be >= 1");
    if (!this.masterSecrets.has(version)) {
      throw new EncryptionError(
        `Cannot promote unknown local key version ${version} — set ENCRYPTION_MASTER_KEY_V${version}`
      );
    }
    this.active = version;
  }

  private assertKnownVersion(version: number): void {
    if (version < 1) throw new EncryptionError("key version must be >= 1");
    if (!this.masterSecrets.has(version)) {
      throw new EncryptionError(
        `Unknown local key version ${version} — set ENCRYPTION_MASTER_KEY_V${version}`
      );
    }
  }
}

export function defaultMasterSecret(): string {
  const value = process.env.ENCRYPTION_MASTER_KEY;
  const nodeEnv = process.env.NODE_ENV ?? "development";
  if (!value || value === DEFAULT_ENCRYPTION_MASTER_KEY) {
    if (nodeEnv === "production") {
      throw new EncryptionError(
        "ENCRYPTION_MASTER_KEY must be set in production and must not equal the default development value"
      );
    }
    return DEFAULT_ENCRYPTION_MASTER_KEY;
  }
  return value;
}

export const DEFAULT_ENCRYPTION_MASTER_KEY = "delego-default-pii-encryption-master-key-32chars!";

// ─── AWS KMS ─────────────────────────────────────────────────────────────────

/**
 * Minimal KMS command surface. A consumer that has @aws-sdk/client-kms
 * installed can supply a compatible adapter (see the default adapter below);
 * tests supply a fake. `Plaintext`/`CiphertextBlob` are Uint8Array per the
 * AWS SDK v3 wire types.
 */
export interface KmsCommands {
  decrypt(input: { CiphertextBlob: Buffer; KeyId?: string }): Promise<{ Plaintext?: Uint8Array }>;
  generateDataKey(input: {
    KeyId: string;
    KeySpec: "AES_256";
  }): Promise<{ Plaintext?: Uint8Array; CiphertextBlob?: Uint8Array }>;
}

export interface AwsKmsKeyProviderConfig {
  keyId: string;
  region?: string;
  commands?: KmsCommands;
  store?: WrappedKeyStore;
  activeVersion?: number;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type KmsModuleShape = {
  KMSClient: new (config: { region?: string }) => { send(command: unknown): Promise<any> };
  DecryptCommand: new (input: { CiphertextBlob: Buffer; KeyId?: string }) => unknown;
  GenerateDataKeyCommand: new (input: { KeyId: string; KeySpec: "AES_256" }) => unknown;
};

let kmsSdkModulePromise: Promise<KmsModuleShape> | null = null;

/** Lazily imports @aws-sdk/client-kms (async) so this package has no hard dependency on it. */
function loadKmsSdk(): Promise<KmsModuleShape> {
  if (!kmsSdkModulePromise) {
    kmsSdkModulePromise = import("@aws-sdk/client-kms").then(
      (m) => m as unknown as KmsModuleShape,
      () => {
        throw new EncryptionError(
          "aws_kms provider requires @aws-sdk/client-kms to be installed by the consuming service"
        );
      }
    );
  }
  return kmsSdkModulePromise;
}

/** Default adapter over the real AWS SDK v3 client, built lazily. */
async function defaultKmsCommands(region?: string): Promise<KmsCommands> {
  const { KMSClient, DecryptCommand, GenerateDataKeyCommand } = await loadKmsSdk();
  const client = new KMSClient({ region: region ?? process.env.AWS_REGION ?? "us-east-1" });
  return {
    async decrypt(input) {
      return client.send(new DecryptCommand(input));
    },
    async generateDataKey(input) {
      return client.send(new GenerateDataKeyCommand(input));
    },
  };
}

export class AwsKmsKeyProvider implements KeyProvider {
  readonly name = "aws_kms" as const;
  readonly keyId: string;
  private readonly store: WrappedKeyStore;
  private active: number;
  private readonly dataKeyCache = new Map<number, DataKey>();
  private readonly resolvedCommands: KmsCommands | undefined;
  private readonly region: string | undefined;

  constructor(config: AwsKmsKeyProviderConfig) {
    if (!config.keyId.trim()) {
      throw new EncryptionError("AWS KMS keyId (alias or ARN) is required");
    }
    this.keyId = config.keyId.trim();
    this.active = config.activeVersion && config.activeVersion >= 1 ? config.activeVersion : 1;
    this.store = config.store ?? new InMemoryWrappedKeyStore();
    this.resolvedCommands = config.commands;
    this.region = config.region;
  }

  private async commands(): Promise<KmsCommands> {
    if (this.resolvedCommands) return this.resolvedCommands;
    return defaultKmsCommands(this.region);
  }

  async activeVersion(): Promise<number> {
    return this.active;
  }

  async getDataKey(version: number): Promise<DataKey> {
    if (this.dataKeyCache.has(version)) return this.dataKeyCache.get(version)!;

    const wrapped = await this.store.get(version);
    if (!wrapped) {
      throw new EncryptionError(
        `No wrapped data key on record for AWS KMS version ${version} — rotate to mint one`
      );
    }

    const response = await (await this.commands()).decrypt({
      CiphertextBlob: Buffer.from(wrapped, "base64"),
      KeyId: this.keyId,
    });
    const plaintext = response?.Plaintext;
    if (!plaintext) {
      throw new EncryptionError("AWS KMS Decrypt returned no plaintext data key");
    }
    const dataKey: DataKey = {
      key: requireKeyBytes(Buffer.from(plaintext)),
      wrappedKey: wrapped,
      keyVersion: version,
      keyId: this.keyId,
    };
    this.dataKeyCache.set(version, dataKey);
    return dataKey;
  }

  async generateDataKey(version: number): Promise<DataKey> {
    if (this.dataKeyCache.has(version)) return this.dataKeyCache.get(version)!;

    const response = await (await this.commands()).generateDataKey({
      KeyId: this.keyId,
      KeySpec: "AES_256",
    });
    const plaintext = response?.Plaintext;
    const blob = response?.CiphertextBlob;
    if (!plaintext || !blob) {
      throw new EncryptionError("AWS KMS GenerateDataKey returned an incomplete payload");
    }
    const dataKey: DataKey = {
      key: requireKeyBytes(Buffer.from(plaintext)),
      wrappedKey: Buffer.from(blob).toString("base64"),
      keyVersion: version,
      keyId: this.keyId,
    };
    await this.store.set(version, dataKey.wrappedKey);
    this.dataKeyCache.set(version, dataKey);
    return dataKey;
  }

  async listVersions(): Promise<number[]> {
    return this.store.list();
  }

  setActiveVersion(version: number): void {
    if (version < 1) throw new EncryptionError("key version must be >= 1");
    this.active = version;
  }
}

// ─── HashiCorp Vault (Transit dynamic data keys) ─────────────────────────────

export interface VaultKeyProviderConfig {
  keyId: string;
  addr?: string;
  token?: string;
  mount?: string;
  fetchImpl?: typeof fetch;
  store?: WrappedKeyStore;
  activeVersion?: number;
}

export class HashicorpVaultKeyProvider implements KeyProvider {
  readonly name = "vault" as const;
  readonly keyId: string;
  private readonly addr: string;
  private readonly token: string;
  private readonly mount: string;
  private readonly fetchImpl: typeof fetch;
  private readonly store: WrappedKeyStore;
  private active: number;
  private readonly dataKeyCache = new Map<number, DataKey>();

  constructor(config: VaultKeyProviderConfig) {
    if (!config.keyId.trim()) throw new EncryptionError("Vault transit key name is required");
    this.keyId = config.keyId.trim();
    this.addr = (config.addr ?? process.env.VAULT_ADDR ?? "").replace(/\/$/, "");
    this.token = config.token ?? process.env.VAULT_TOKEN ?? "";
    this.mount = config.mount ?? process.env.VAULT_TRANSIT_MOUNT ?? "transit";
    this.fetchImpl = config.fetchImpl ?? fetch;
    this.store = config.store ?? new InMemoryWrappedKeyStore();
    this.active = config.activeVersion && config.activeVersion >= 1 ? config.activeVersion : 1;

    if (!this.addr) throw new EncryptionError("VAULT_ADDR is required for the vault key provider");
    if (!this.token) throw new EncryptionError("VAULT_TOKEN is required for the vault key provider");
  }

  private async request(method: "GET" | "POST", path: string, body?: Record<string, unknown>): Promise<any> {
    const response = await this.fetchImpl(`${this.addr}${path}`, {
      method,
      headers: {
        "X-Vault-Token": this.token,
        "Content-Type": "application/json",
      },
      ...(body ? { body: JSON.stringify(body) } : {}),
    });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const payload: any = await response.json().catch(() => ({}));
    if (!response.ok) {
      const message =
        typeof payload?.errors?.[0] === "string"
          ? payload.errors[0]
          : `Vault request failed with status ${response.status}`;
      throw new EncryptionError(`Vault transit error: ${message}`);
    }
    return payload;
  }

  async activeVersion(): Promise<number> {
    return this.active;
  }

  async getDataKey(version: number): Promise<DataKey> {
    if (this.dataKeyCache.has(version)) return this.dataKeyCache.get(version)!;

    const wrapped = await this.store.get(version);
    if (!wrapped) {
      throw new EncryptionError(
        `No wrapped data key on record for Vault version ${version} — rotate to mint one`
      );
    }

    const path = `/v1/${this.mount}/decrypt/${encodeURIComponent(this.keyId)}`;
    const payload = await this.request("POST", path, { ciphertext: wrapped });
    const plaintextB64 = payload?.data?.plaintext;
    if (typeof plaintextB64 !== "string" || !plaintextB64) {
      throw new EncryptionError("Vault transit decrypt returned no plaintext data key");
    }
    const dataKey: DataKey = {
      key: requireKeyBytes(Buffer.from(plaintextB64, "base64")),
      wrappedKey: wrapped,
      keyVersion: version,
      keyId: this.keyId,
    };
    this.dataKeyCache.set(version, dataKey);
    return dataKey;
  }

  async generateDataKey(version: number): Promise<DataKey> {
    if (this.dataKeyCache.has(version)) return this.dataKeyCache.get(version)!;

    const path = `/v1/${this.mount}/datakey/plaintext/${encodeURIComponent(this.keyId)}`;
    const payload = await this.request("POST", path);
    const wrapped = payload?.data?.ciphertext;
    const plaintextB64 = payload?.data?.plaintext;
    if (typeof wrapped !== "string" || typeof plaintextB64 !== "string") {
      throw new EncryptionError("Vault transit datakey/plaintext returned an incomplete payload");
    }
    const dataKey: DataKey = {
      key: requireKeyBytes(Buffer.from(plaintextB64, "base64")),
      wrappedKey: wrapped,
      keyVersion: version,
      keyId: this.keyId,
    };
    await this.store.set(version, dataKey.wrappedKey);
    this.dataKeyCache.set(version, dataKey);
    return dataKey;
  }

  async listVersions(): Promise<number[]> {
    return this.store.list();
  }

  setActiveVersion(version: number): void {
    if (version < 1) throw new EncryptionError("key version must be >= 1");
    this.active = version;
  }
}

// ─── factory ────────────────────────────────────────────────────────────────

export type AnyKeyProviderConfig =
  | { provider: "local"; keyId?: string; activeVersion?: number; secrets?: Record<number, string> }
  | ({ provider: "aws_kms" } & AwsKmsKeyProviderConfig)
  | ({ provider: "vault" } & VaultKeyProviderConfig);

export function createKeyProvider(config: AnyKeyProviderConfig): KeyProvider {
  switch (config.provider) {
    case "local":
      return new LocalKeyProvider({ keyId: config.keyId, activeVersion: config.activeVersion, secrets: config.secrets });
    case "aws_kms":
      return new AwsKmsKeyProvider(config);
    case "vault":
      return new HashicorpVaultKeyProvider(config);
    default:
      throw new EncryptionError(`Unsupported key provider: ${String((config as any).provider)}`);
  }
}