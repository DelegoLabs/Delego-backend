/**
 * Unit tests for #68 — key providers: local, aws_kms (envelope), vault.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import * as crypto from "node:crypto";
import {
  LocalKeyProvider,
  AwsKmsKeyProvider,
  HashicorpVaultKeyProvider,
  createKeyProvider,
  InMemoryWrappedKeyStore,
  EncryptionError,
} from "./keyProvider.js";
import type { KmsCommands } from "./keyProvider.js";

const ORIGINAL_ENV = { ...process.env };

afterEach(() => {
  process.env = { ...ORIGINAL_ENV };
  vi.restoreAllMocks();
});

describe("LocalKeyProvider", () => {
  let provider: LocalKeyProvider;
  beforeEach(() => {
    provider = new LocalKeyProvider({
      keyId: "primary",
      secrets: { 1: "test-master-secret-32-chars-long!!", 2: "test-second-secret-32-chars-long!" },
      activeVersion: 2,
    });
  });

  it("reports the configured active version", async () => {
    expect(await provider.activeVersion()).toBe(2);
  });

  it("derives a stable 32-byte data key per version", async () => {
    const k1 = await provider.getDataKey(1);
    const k1again = await provider.getDataKey(1);
    expect(k1.key).toHaveLength(32);
    expect(k1.key.equals(k1again.key)).toBe(true);
    expect(k1.keyVersion).toBe(1);
    expect(k1.keyId).toBe("primary");
  });

  it("derives different keys for different versions", async () => {
    const k1 = await provider.getDataKey(1);
    const k2 = await provider.getDataKey(2);
    expect(k1.key.equals(k2.key)).toBe(false);
  });

  it("persists a wrapped fingerprint per version", async () => {
    const k1 = await provider.getDataKey(1);
    expect(k1.wrappedKey).toMatch(/^[0-9a-f]{64}$/);
  });

  it("throws for an unknown version", async () => {
    await expect(provider.getDataKey(99)).rejects.toThrow(EncryptionError);
  });

  it("rejects short master secrets", () => {
    expect(
      () =>
        new LocalKeyProvider({
          secrets: { 1: "short" },
        })
    ).toThrow(EncryptionError);
  });
});

describe("LocalKeyProvider env wiring", () => {
  it("reads ENCRYPTION_MASTER_KEY for version 1", async () => {
    process.env.ENCRYPTION_MASTER_KEY = "env-based-master-secret-32-chars!!";
    const provider = new LocalKeyProvider();
    const key = await provider.getDataKey(1);
    expect(key.key).toHaveLength(32);
  });

  it("falls back to the documented dev default when unset in development", async () => {
    delete process.env.ENCRYPTION_MASTER_KEY;
    process.env.NODE_ENV = "development";
    const provider = new LocalKeyProvider();
    expect((await provider.getDataKey(1)).key).toHaveLength(32);
  });

  it("fails closed in production when the master key is unset", () => {
    delete process.env.ENCRYPTION_MASTER_KEY;
    process.env.NODE_ENV = "production";
    expect(() => new LocalKeyProvider()).toThrow(EncryptionError);
  });
});

describe("AwsKmsKeyProvider (envelope encryption)", () => {
  function fakeKms({ store }: { store?: InMemoryWrappedKeyStore } = {}) {
    const generated = new Map<number, { plain: Buffer; wrapped: Buffer }>();
    const commands: KmsCommands = {
      async decrypt({ CiphertextBlob }) {
        const match = [...generated.entries()].find(([, v]) => v.wrapped.equals(CiphertextBlob));
        if (!match) throw new Error("KMS: ciphertext blob not found");
        return { Plaintext: match[1].plain };
      },
      async generateDataKey() {
        const plain = crypto.randomBytes(32);
        const wrapped = crypto.randomBytes(64);
        generated.set(generated.size + 1, { plain, wrapped });
        return { Plaintext: plain, CiphertextBlob: wrapped };
      },
    };
    return { commands, generated, store: store ?? new InMemoryWrappedKeyStore() };
  }

  it("mints a data key and unwraps it for reads (envelope)", async () => {
    const fixture = fakeKms();
    const provider = new AwsKmsKeyProvider({
      keyId: "alias/delego-pii",
      commands: fixture.commands,
      store: fixture.store,
      activeVersion: 1,
    });

    const minted = await provider.generateDataKey(1);
    expect(minted.key).toHaveLength(32);
    expect(minted.keyVersion).toBe(1);
    // wrapped copy persisted to the store
    expect(await fixture.store.get(1)).toBe(minted.wrappedKey);

    // A second provider instance (same store) can unwrap without re-minting:
    const provider2 = new AwsKmsKeyProvider({
      keyId: "alias/delego-pii",
      commands: fixture.commands,
      store: fixture.store,
    });
    const unwrapped = await provider2.getDataKey(1);
    expect(unwrapped.key.equals(minted.key)).toBe(true);
  });

  it("caches the data key after the first unwrap", async () => {
    const fixture = fakeKms();
    const decryptSpy = vi.spyOn(fixture.commands, "decrypt");
    const provider = new AwsKmsKeyProvider({
      keyId: "kms-key",
      commands: fixture.commands,
      store: fixture.store,
    });
    await provider.generateDataKey(1);
    // reset spy state after minting so we only observe getDataKey unwraps
    decryptSpy.mockClear();

    await provider.getDataKey(1);
    const callsAfterFirstUnwrap = decryptSpy.mock.calls.length;
    await provider.getDataKey(1);
    expect(decryptSpy).toHaveBeenCalledTimes(callsAfterFirstUnwrap); // no second unwrap
  });

  it("throws when reading a version with no wrapped key", async () => {
    const fixture = fakeKms();
    const provider = new AwsKmsKeyProvider({
      keyId: "kms-key",
      commands: fixture.commands,
      store: fixture.store,
    });
    await expect(provider.getDataKey(7)).rejects.toThrow(EncryptionError);
  });

  it("requires a keyId", () => {
    expect(() => new AwsKmsKeyProvider({ keyId: "", commands: fakeKms().commands })).toThrow(
      EncryptionError
    );
  });
});

describe("HashicorpVaultKeyProvider (transit dynamic data keys)", () => {
  function fakeFetch() {
    const datakeys = new Map<number, { ciphertext: string; plaintext: string }>();
    const fetchImpl = vi.fn(async (url: string, init?: { method?: string; body?: string }) => {
      const method = init?.method ?? "GET";
      if (url.includes("/datakey/plaintext/pii-key")) {
        const plain = crypto.randomBytes(32).toString("base64");
        const wrapped = `vault:v1:${crypto.randomBytes(32).toString("base64")}`;
        datakeys.set(datakeys.size + 1, { ciphertext: wrapped, plaintext: plain });
        return {
          ok: true,
          status: 200,
          async json() {
            return { data: { ciphertext: wrapped, plaintext: plain } };
          },
        };
      }
      if (url.includes("/decrypt/pii-key")) {
        const body = JSON.parse(init?.body ?? "{}");
        const match = [...datakeys.entries()].find(([, v]) => v.ciphertext === body.ciphertext);
        if (!match) {
          return { ok: false, status: 400, async json() { return { errors: ["invalid ciphertext"] }; } };
        }
        return {
          ok: true,
          status: 200,
          async json() {
            return { data: { plaintext: match[1].plaintext } };
          },
        };
      }
      return { ok: false, status: 404, async json() { return { errors: ["not found"] }; } };
    });

    const store = new InMemoryWrappedKeyStore();
    return {
      fetchImpl: fetchImpl as unknown as typeof fetch,
      store,
      datakeys,
    };
  }

  it("mints and unwraps transit dynamic data keys", async () => {
    const vault = fakeFetch();
    const provider = new HashicorpVaultKeyProvider({
      keyId: "pii-key",
      addr: "https://vault.example.com",
      token: "s.token",
      mount: "transit",
      fetchImpl: vault.fetchImpl,
      store: vault.store,
      activeVersion: 1,
    });

    const minted = await provider.generateDataKey(1);
    expect(minted.key).toHaveLength(32);
    expect(minted.wrappedKey).toMatch(/^vault:v1:/);
    expect(await vault.store.get(1)).toBe(minted.wrappedKey);

    const unwrapped = await provider.getDataKey(1);
    expect(unwrapped.key.equals(minted.key)).toBe(true);
  });

  it("requires addr and token", () => {
    expect(
      () =>
        new HashicorpVaultKeyProvider({
          keyId: "pii-key",
          addr: "",
          token: "t",
          store: new InMemoryWrappedKeyStore(),
        })
    ).toThrow(EncryptionError);
    expect(
      () =>
        new HashicorpVaultKeyProvider({
          keyId: "pii-key",
          addr: "https://vault.example.com",
          token: "",
          store: new InMemoryWrappedKeyStore(),
        })
    ).toThrow(EncryptionError);
  });
});

describe("createKeyProvider factory", () => {
  it("builds a local provider", () => {
    const provider = createKeyProvider({ provider: "local", keyId: "x" });
    expect(provider).toBeInstanceOf(LocalKeyProvider);
  });
  it("builds an aws_kms provider", () => {
    const provider = createKeyProvider({
      provider: "aws_kms",
      keyId: "alias/pii",
      commands: {
        async decrypt() {
          return { Plaintext: crypto.randomBytes(32) };
        },
        async generateDataKey() {
          return { Plaintext: crypto.randomBytes(32), CiphertextBlob: crypto.randomBytes(64) };
        },
      },
    });
    expect(provider).toBeInstanceOf(AwsKmsKeyProvider);
  });
  it("builds a vault provider", () => {
    const provider = createKeyProvider({
      provider: "vault",
      keyId: "pii-key",
      addr: "https://vault.example.com",
      token: "t",
      fetchImpl: async () => ({ ok: false, status: 404, async json() { return {}; } }) as Response,
    });
    expect(provider).toBeInstanceOf(HashicorpVaultKeyProvider);
  });
  it("rejects an unknown provider", () => {
    expect(() => createKeyProvider({ provider: "nope" } as any)).toThrow(EncryptionError);
  });
});