/**
 * Unit tests for #31 — wallet fails startup if WALLET_MASTER_SECRET equals the
 * hardcoded default value in production, and warns (but proceeds) in development.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const originalEnv = { ...process.env };

async function importVaultModule() {
  vi.resetModules();
  return import("./vault.js");
}

describe("VaultService master secret guard (#31)", () => {
  beforeEach(() => {
    vi.resetModules();
  });

  afterEach(() => {
    process.env = { ...originalEnv };
  });

  it("fails startup (module import throws) in production when WALLET_MASTER_SECRET is unset", async () => {
    process.env.NODE_ENV = "production";
    delete process.env.WALLET_MASTER_SECRET;

    // The module eagerly constructs a shared `vaultService` singleton at import time
    // (`export const vaultService = new VaultService()`), so an unsafe default surfaces
    // as the import itself throwing — which is the desired "fail startup" behavior.
    await expect(importVaultModule()).rejects.toThrow(/WALLET_MASTER_SECRET must be set in production/);
  });

  it("fails startup (module import throws) in production when WALLET_MASTER_SECRET equals the default value", async () => {
    process.env.NODE_ENV = "production";
    process.env.WALLET_MASTER_SECRET = "default-dev-wallet-master-secret-key-32-chars";

    await expect(importVaultModule()).rejects.toThrow(/WALLET_MASTER_SECRET must be set in production/);
  });

  it("does not throw in production when a non-default secret is configured", async () => {
    process.env.NODE_ENV = "production";
    process.env.WALLET_MASTER_SECRET = "a-real-32-char-production-secret";

    const { VaultService } = await importVaultModule();
    expect(() => new VaultService()).not.toThrow();
  });

  it("warns but allows construction in development when secret is unset", async () => {
    process.env.NODE_ENV = "development";
    delete process.env.WALLET_MASTER_SECRET;

    const { VaultService } = await importVaultModule();
    expect(() => new VaultService()).not.toThrow();
  });

  it("warns but allows construction in development when secret equals the default value", async () => {
    process.env.NODE_ENV = "development";
    process.env.WALLET_MASTER_SECRET = "default-dev-wallet-master-secret-key-32-chars";

    const { VaultService } = await importVaultModule();
    expect(() => new VaultService()).not.toThrow();
  });

  it("does not throw when NODE_ENV is unset (treated as non-production)", async () => {
    delete process.env.NODE_ENV;
    delete process.env.WALLET_MASTER_SECRET;

    const { VaultService } = await importVaultModule();
    expect(() => new VaultService()).not.toThrow();
  });

  it("getMasterKeyForVersion applies the same production guard for the v1/default fallback", async () => {
    // Import with a safe secret first so the module-level `vaultService` singleton
    // construction succeeds; only WALLET_MASTER_SECRET is dropped afterwards so that
    // getMasterKeyForVersion("v1") is exercised directly against the unsafe-default guard.
    process.env.NODE_ENV = "production";
    process.env.WALLET_MASTER_SECRET = "a-real-32-char-production-secret";
    const { getMasterKeyForVersion } = await importVaultModule();

    delete process.env.WALLET_MASTER_SECRET;
    expect(() => getMasterKeyForVersion("v1")).toThrow(/WALLET_MASTER_SECRET must be set in production/);
  });

  it("getMasterKeyForVersion does not throw in development for the v1/default fallback", async () => {
    process.env.NODE_ENV = "development";
    delete process.env.WALLET_MASTER_SECRET;

    const { getMasterKeyForVersion } = await importVaultModule();
    expect(getMasterKeyForVersion("v1")).toBe("default-dev-wallet-master-secret-key-32-chars");
  });
});
