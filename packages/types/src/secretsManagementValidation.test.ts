import { describe, it, expect } from "vitest";
import { validateSecretConfig } from "./secretsManagementValidation.js";
import type { SecretConfig } from "./secretsManagement.js";

function buildSecretConfig(overrides: Partial<SecretConfig> = {}): SecretConfig {
  return {
    path: "database/creds/orders-service",
    type: "database",
    rotation: { enabled: true, interval: "0 0 * * *" },
    policies: [{ path: "database/creds/orders-service", capabilities: ["read"] }],
    ttl: "24h",
    maxVersions: 5,
    ...overrides,
  };
}

describe("validateSecretConfig — valid configs", () => {
  it("passes a well-formed database secret with rotation enabled", () => {
    const result = validateSecretConfig(buildSecretConfig());
    expect(result.valid).toBe(true);
    expect(result.errors).toEqual([]);
  });

  it("accepts common duration formats for ttl", () => {
    for (const ttl of ["30s", "5m", "24h", "7d"]) {
      expect(validateSecretConfig(buildSecretConfig({ ttl })).valid).toBe(true);
    }
  });
});

describe("validateSecretConfig — structural errors", () => {
  it("fails when path is missing", () => {
    const result = validateSecretConfig(buildSecretConfig({ path: "" }));
    expect(result.valid).toBe(false);
    expect(result.errors).toContain("Secret config is missing a path");
  });

  it("fails for an invalid ttl format", () => {
    const result = validateSecretConfig(buildSecretConfig({ ttl: "one day" }));
    expect(result.valid).toBe(false);
    expect(result.errors[0]).toMatch(/Invalid ttl/);
  });

  it("fails when maxVersions is less than 1", () => {
    const result = validateSecretConfig(buildSecretConfig({ maxVersions: 0 }));
    expect(result.valid).toBe(false);
  });
});

describe("validateSecretConfig — rotation", () => {
  it("fails for a malformed cron interval when rotation is enabled", () => {
    const result = validateSecretConfig(
      buildSecretConfig({ rotation: { enabled: true, interval: "not-a-cron-expression" } }),
    );
    expect(result.valid).toBe(false);
    expect(result.errors[0]).toMatch(/Invalid rotation.interval/);
  });

  it("warns when a non-database type has rotation enabled with no script", () => {
    const result = validateSecretConfig(
      buildSecretConfig({ type: "kv", rotation: { enabled: true, interval: "0 0 * * *" } }),
    );
    expect(result.valid).toBe(true);
    expect(result.warnings.some((w) => w.includes("rotation.script"))).toBe(true);
  });

  it("does not warn about a missing script for a database secret (rotation.script is optional there)", () => {
    const result = validateSecretConfig(buildSecretConfig({ type: "database" }));
    expect(result.warnings.some((w) => w.includes("rotation.script"))).toBe(false);
  });

  it("warns when a database secret has rotation disabled", () => {
    const result = validateSecretConfig(
      buildSecretConfig({ type: "database", rotation: { enabled: false, interval: "" } }),
    );
    expect(result.warnings.some((w) => w.includes("rotation is disabled"))).toBe(true);
  });
});

describe("validateSecretConfig — policies", () => {
  it("warns when a secret has no access policies", () => {
    const result = validateSecretConfig(buildSecretConfig({ policies: [] }));
    expect(result.warnings.some((w) => w.includes("no access policies"))).toBe(true);
  });

  it("fails when a policy grants no capabilities", () => {
    const result = validateSecretConfig(
      buildSecretConfig({ policies: [{ path: "kv/foo", capabilities: [] }] }),
    );
    expect(result.valid).toBe(false);
    expect(result.errors[0]).toMatch(/grants no capabilities/);
  });

  it("aggregates errors across multiple policies", () => {
    const result = validateSecretConfig(
      buildSecretConfig({
        policies: [
          { path: "kv/a", capabilities: [] },
          { path: "kv/b", capabilities: [] },
        ],
      }),
    );
    expect(result.errors).toHaveLength(2);
  });
});
