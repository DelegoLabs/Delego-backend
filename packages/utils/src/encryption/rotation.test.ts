/**
 * Unit tests for #68 — key rotation with dual encryption (zero downtime).
 */
import { describe, it, expect, beforeEach } from "vitest";
import { ColumnEncryptor } from "./columnEncryptor.js";
import { LocalKeyProvider } from "./keyProvider.js";
import { KeyAccessAuditor } from "./audit.js";
import { FieldAccessController } from "./accessControl.js";
import {
  KeyRotationManager,
  InMemoryEncryptionKeyVersionStore,
  dualEncryptField,
} from "./rotation.js";
import type { EncryptedField } from "@delegolabs/types";

interface StoredValue {
  field: EncryptedField;
  context: Record<string, string>;
}

const SECRETS: Record<number, string> = {
  1: "rotation-v1-master-32-characters!!",
  2: "rotation-v2-master-32-characters!!",
};

let provider: LocalKeyProvider;
let encryptor: ColumnEncryptor;
let versionStore: InMemoryEncryptionKeyVersionStore;
let manager: KeyRotationManager;

beforeEach(async () => {
  provider = new LocalKeyProvider({ keyId: "primary", secrets: SECRETS, activeVersion: 1 });
  encryptor = new ColumnEncryptor({
    keyProvider: provider,
    access: new FieldAccessController(),
    audit: new KeyAccessAuditor(),
    config: { algorithm: "AES-256-GCM", keyProvider: "local", keyId: "primary", keyRotationDays: 90 },
  });
  versionStore = new InMemoryEncryptionKeyVersionStore();
  manager = new KeyRotationManager({
    keyProvider: provider,
    versionStore,
    audit: new KeyAccessAuditor(),
    rotationDays: 90,
  });
});

function makeTarget(value: StoredValue): { read: () => Promise<{ field: EncryptedField; context: Record<string, string> } | null>; write: (f: EncryptedField) => Promise<void>; written: EncryptedField[] } {
  const written: EncryptedField[] = [];
  return {
    read: () => Promise.resolve(value.field ? { field: value.field, context: value.context } : null),
    write: async (f) => {
      value.field = f;
      written.push(f);
    },
    written,
  };
}

describe("KeyRotationManager.beginRotation", () => {
  it("mints the next version and demotes the current one", async () => {
    await manager.recordVersion(1, await provider.getDataKey(1));
    const { nextVersion, status } = await manager.beginRotation();

    expect(nextVersion).toBe(2);
    expect(status.currentVersion).toBe(2);
    expect(status.previousVersion).toBe(1);
    expect(status.rotationInProgress).toBe(true);

    const rows = await versionStore.list("primary");
    expect(rows.find((r) => r.version === 1)?.status).toBe("previous");
    expect(rows.find((r) => r.version === 2)?.status).toBe("active");
  });

  it("refuses concurrent rotations", async () => {
    await manager.recordVersion(1, await provider.getDataKey(1));
    await manager.beginRotation();
    await expect(manager.beginRotation()).rejects.toThrow(/already in progress/);
  });
});

describe("rotation is seamless (zero downtime)", () => {
  it("both key versions still decrypt during the rotation window (dual encryption)", async () => {
    await manager.recordVersion(1, await provider.getDataKey(1));
    const ctx = { userId: "row-1" };
    const v1Field = await encryptor.encrypt("users", "email", "dual@x.com", { context: ctx, keyVersion: 1 });

    await manager.beginRotation();
    // active has moved to v2; v1 value still decrypts
    expect((await encryptor.decrypt("users", "email", v1Field, { context: ctx })).plaintext).toBe(
      "dual@x.com"
    );
    // new writes land on v2
    const v2Field = await encryptor.encrypt("users", "email", "dual@x.com", { context: ctx });
    expect(v2Field.keyVersion).toBe(2);
  });
});

describe("reEncryptValue / dualEncryptField", () => {
  it("re-encrypts a stored value onto the active version, decryptable before and after", async () => {
    await manager.recordVersion(1, await provider.getDataKey(1));
    const ctx = { userId: "migrate-me" };
    const v1Field = await encryptor.encrypt("users", "email", "migrate@x.com", { context: ctx, keyVersion: 1 });
    const target = makeTarget({ field: v1Field, context: ctx });

    await manager.beginRotation(); // v2 is now active

    const moved = await manager.reEncryptValue(target, ctx);
    expect(moved).toBe(true);
    expect(target.written[0].keyVersion).toBe(2);
    expect(target.written[0].ciphertext).not.toBe(v1Field.ciphertext);

    // readable with the encryptor (which follows the field's keyVersion)
    expect((await encryptor.decrypt("users", "email", target.written[0], { context: ctx })).plaintext).toBe(
      "migrate@x.com"
    );
    // and the OLD ciphertext also still decrypts
    expect((await encryptor.decrypt("users", "email", v1Field, { context: ctx })).plaintext).toBe(
      "migrate@x.com"
    );
  });

  it("skips values already on the active version", async () => {
    await manager.recordVersion(1, await provider.getDataKey(1));
    await manager.recordVersion(2, await provider.getDataKey(2));
    const target = makeTarget({
      field: await encryptor.encrypt("users", "email", "current@x.com", { keyVersion: 2 }),
      context: {},
    });
    const moved = await manager.reEncryptValue(target, {});
    expect(moved).toBe(false);
    expect(target.written).toHaveLength(0);
  });

  it("sweeps an async iterable of values and reports totals", async () => {
    await manager.recordVersion(1, await provider.getDataKey(1));
    const targets = Array.from({ length: 3 }, () =>
      makeTarget({ field: undefined as never, context: {} })
    );
    for (const [i, t] of targets.entries()) {
      const f = await encryptor.encrypt("users", "email", `u${i}@x.com`, { keyVersion: 1 });
      t.read = () => Promise.resolve({ field: f, context: {} });
    }
    await manager.beginRotation();

    async function* gen() {
      for (const t of targets) yield t;
    }
    const result = await manager.reEncryptAll(gen());
    expect(result.scanned).toBe(3);
    expect(result.rotated).toBe(3);
    expect(result.skipped).toBe(0);
    for (const t of targets) {
      expect(t.written[0].keyVersion).toBe(2);
    }
  });

  it("dualEncryptField rejects when the old key cannot decrypt (wrong provider)", async () => {
    await expect(
      dualEncryptField(
        {
          ciphertext: "AAAA",
          iv: Buffer.alloc(12).toString("base64"),
          authTag: Buffer.alloc(16, 1).toString("base64"),
          keyVersion: 1,
          algorithm: "AES-256-GCM",
        },
        await provider.getDataKey(2),
        await provider.getDataKey(2),
        "AES-256-GCM",
        {},
        2
      )
    ).rejects.toThrow(/dualEncryptField failed/);
  });
});

describe("completeRotation / cancelRotation / status", () => {
  it("completes once no rows reference the previous version", async () => {
    await manager.recordVersion(1, await provider.getDataKey(1));
    await manager.beginRotation();

    const status = await manager.completeRotation(async () => 0);
    expect(status.rotationInProgress).toBe(false);
    const rows = await versionStore.list("primary");
    expect(rows.find((r) => r.version === 1)?.status).toBe("retired");
    expect(rows.find((r) => r.version === 2)?.status).toBe("active");
  });

  it("refuses to complete while previous-version rows remain", async () => {
    await manager.recordVersion(1, await provider.getDataKey(1));
    await manager.beginRotation();
    await expect(manager.completeRotation(async () => 17)).rejects.toThrow(/re-encrypt first/);
  });

  it("cancelRotation clears the in-progress flag", async () => {
    await manager.recordVersion(1, await provider.getDataKey(1));
    await manager.beginRotation();
    const status = await manager.cancelRotation();
    expect(status.rotationInProgress).toBe(false);
  });

  it("status reports nextRotationAt based on the rotation days", async () => {
    await manager.recordVersion(1, await provider.getDataKey(1));
    const status = await manager.status();
    expect(status.keyId).toBe("primary");
    expect(status.currentVersion).toBe(1);
    expect(status.previousVersion).toBeUndefined();
    const gapMs = new Date(status.nextRotationAt).getTime() - new Date(status.lastRotatedAt).getTime();
    expect(gapMs).toBe(90 * 24 * 60 * 60 * 1000);
  });
});