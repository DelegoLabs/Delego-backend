/**
 * Unit tests for #30 — notifications service fails startup if JWT_SECRET equals the
 * hardcoded default value in production, and warns (but proceeds) in development.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const originalEnv = { ...process.env };

async function importWebsocketModule() {
  vi.resetModules();
  return import("./websocket.js");
}

describe("notifications JWT secret guard (#30)", () => {
  beforeEach(() => {
    vi.resetModules();
    // Keep the module's Redis subscription side effect disabled regardless of NODE_ENV.
    process.env.MOCK_REDIS = "true";
  });

  afterEach(() => {
    process.env = { ...originalEnv };
  });

  it("fails startup (module import throws) in production when JWT_SECRET is unset", async () => {
    process.env.NODE_ENV = "production";
    delete process.env.JWT_SECRET;

    // JWT_SECRET is resolved once at module scope (`const JWT_SECRET = resolveJwtSecret()`),
    // so an unsafe default surfaces as the import itself throwing — the desired "fail
    // startup" behavior.
    await expect(importWebsocketModule()).rejects.toThrow(
      /JWT_SECRET must be set in production/
    );
  });

  it("fails startup (module import throws) in production when JWT_SECRET equals the default value", async () => {
    process.env.NODE_ENV = "production";
    process.env.JWT_SECRET = "change-me-in-production";

    await expect(importWebsocketModule()).rejects.toThrow(
      /JWT_SECRET must be set in production/
    );
  });

  it("does not throw in production when a non-default secret is configured", async () => {
    process.env.NODE_ENV = "production";
    process.env.JWT_SECRET = "a-real-production-secret";

    await expect(importWebsocketModule()).resolves.toBeDefined();
  });

  it("warns but allows import in development when JWT_SECRET is unset", async () => {
    process.env.NODE_ENV = "development";
    delete process.env.JWT_SECRET;

    await expect(importWebsocketModule()).resolves.toBeDefined();
  });

  it("warns but allows import in development when JWT_SECRET equals the default value", async () => {
    process.env.NODE_ENV = "development";
    process.env.JWT_SECRET = "change-me-in-production";

    await expect(importWebsocketModule()).resolves.toBeDefined();
  });

  it("does not throw when NODE_ENV is unset (treated as non-production)", async () => {
    delete process.env.NODE_ENV;
    delete process.env.JWT_SECRET;

    await expect(importWebsocketModule()).resolves.toBeDefined();
  });

  describe("resolveJwtSecret (direct unit tests)", () => {
    it("throws in production when unset", async () => {
      const { resolveJwtSecret } = await importWebsocketModule();
      expect(() => resolveJwtSecret(undefined, "production")).toThrow(
        /JWT_SECRET must be set in production/
      );
    });

    it("throws in production when equal to the default value", async () => {
      const { resolveJwtSecret } = await importWebsocketModule();
      expect(() => resolveJwtSecret("change-me-in-production", "production")).toThrow(
        /JWT_SECRET must be set in production/
      );
    });

    it("returns the configured secret unchanged when not default", async () => {
      const { resolveJwtSecret } = await importWebsocketModule();
      expect(resolveJwtSecret("my-real-secret", "production")).toBe("my-real-secret");
    });

    it("falls back to the default and warns in development", async () => {
      const { resolveJwtSecret, DEFAULT_NOTIFICATIONS_JWT_SECRET } = await importWebsocketModule();
      expect(resolveJwtSecret(undefined, "development")).toBe(DEFAULT_NOTIFICATIONS_JWT_SECRET);
    });
  });
});
