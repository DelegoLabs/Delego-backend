import { describe, it, expect } from "vitest";
import { validateCdnConfig, OWASP_BASELINE_RULE_IDS } from "./cdnValidation.js";
import type { CdnConfig, CdnZoneConfig, WafRule } from "./cdn.js";

function buildBaselineWafRules(action: WafRule["action"] = "block"): WafRule[] {
  return OWASP_BASELINE_RULE_IDS.map((id) => ({ id, action, expression: `cf.threat_score > 10` }));
}

function buildZone(overrides: Partial<CdnZoneConfig> = {}): CdnZoneConfig {
  return {
    domain: "app.delego.io",
    origin: "origin.delego.io",
    sslMode: "strict",
    cacheRules: [],
    wafRules: buildBaselineWafRules(),
    ...overrides,
  };
}

function buildConfig(overrides: Partial<CdnConfig> = {}): CdnConfig {
  return {
    provider: "cloudflare",
    zones: [buildZone()],
    edgeFunctions: [],
    ...overrides,
  };
}

describe("validateCdnConfig", () => {
  it("passes a config with full OWASP baseline WAF coverage", () => {
    const result = validateCdnConfig(buildConfig());
    expect(result.valid).toBe(true);
    expect(result.errors).toEqual([]);
  });

  it("fails a config with no zones", () => {
    const result = validateCdnConfig(buildConfig({ zones: [] }));
    expect(result.valid).toBe(false);
    expect(result.errors).toContain("CDN config must declare at least one zone");
  });

  it("fails a zone missing baseline WAF rules", () => {
    const result = validateCdnConfig(buildConfig({ zones: [buildZone({ wafRules: [] })] }));
    expect(result.valid).toBe(false);
    expect(result.errors[0]).toMatch(/missing baseline WAF coverage/);
  });

  it("lists every missing baseline rule id, not just the first", () => {
    const partial = buildBaselineWafRules().slice(0, 2);
    const result = validateCdnConfig(buildConfig({ zones: [buildZone({ wafRules: partial })] }));
    const missingIds = OWASP_BASELINE_RULE_IDS.slice(2);
    for (const id of missingIds) {
      expect(result.errors[0]).toContain(id);
    }
  });

  it("fails when a baseline rule is set to 'allow' instead of block/challenge", () => {
    const rules = buildBaselineWafRules();
    rules[0] = { ...rules[0], action: "allow" };
    const result = validateCdnConfig(buildConfig({ zones: [buildZone({ wafRules: rules })] }));
    expect(result.errors.some((e) => e.includes("set to 'allow'"))).toBe(true);
  });

  it("fails a zone with no domain or no origin", () => {
    const result = validateCdnConfig(
      buildConfig({ zones: [buildZone({ domain: "", origin: "" })] }),
    );
    expect(result.errors).toContain("Zone is missing a domain");
  });

  it("fails a cache rule with a negative TTL", () => {
    const zone = buildZone({
      cacheRules: [{ pattern: "*.js", ttl: -1, browserTtl: 3600, cacheKey: [] }],
    });
    const result = validateCdnConfig(buildConfig({ zones: [zone] }));
    expect(result.errors.some((e) => e.includes("negative TTL"))).toBe(true);
  });

  it("fails on duplicate edge function names", () => {
    const fn = { name: "auth-redirect", script: "...", triggers: [{ event: "request", pattern: "/*" }] };
    const result = validateCdnConfig(buildConfig({ edgeFunctions: [fn, fn] }));
    expect(result.errors).toContain("Duplicate edge function name: auth-redirect");
  });

  it("warns (but does not fail) on an edge function with no triggers", () => {
    const fn = { name: "unused-fn", script: "...", triggers: [] };
    const result = validateCdnConfig(buildConfig({ edgeFunctions: [fn] }));
    expect(result.valid).toBe(true);
    expect(result.warnings.some((w) => w.includes("unused-fn"))).toBe(true);
  });

  it("validates every zone independently, aggregating all errors", () => {
    const result = validateCdnConfig(
      buildConfig({
        zones: [buildZone({ domain: "a.com", wafRules: [] }), buildZone({ domain: "b.com", wafRules: [] })],
      }),
    );
    expect(result.errors).toHaveLength(2);
  });
});
