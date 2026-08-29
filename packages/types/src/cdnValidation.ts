/**
 * CDN config validation (Issue #99).
 *
 * Checks structural validity and baseline WAF coverage against an
 * OWASP-Top-10-style rule checklist. This is a config *linter*, not a
 * live security scanner — it verifies the config declares rules with the
 * expected ids, not that the underlying provider actually enforces them
 * correctly.
 */

import type { CdnConfig, CdnZoneConfig } from "./cdn.js";

/**
 * Baseline WAF rule ids a zone should declare to claim OWASP Top 10
 * coverage. Real deployments may use provider-specific managed rule sets
 * instead of one-rule-per-category; this checklist exists so a config
 * missing coverage entirely fails loudly rather than silently.
 */
export const OWASP_BASELINE_RULE_IDS = [
  "sqli",
  "xss",
  "path-traversal",
  "rce",
  "ssrf",
] as const;

export interface CdnValidationResult {
  valid: boolean;
  errors: string[];
  warnings: string[];
}

export function validateCdnConfig(config: CdnConfig): CdnValidationResult {
  const errors: string[] = [];
  const warnings: string[] = [];

  if (config.zones.length === 0) {
    errors.push("CDN config must declare at least one zone");
  }

  for (const zone of config.zones) {
    errors.push(...validateZone(zone));
  }

  const edgeFunctionNames = new Set<string>();
  for (const fn of config.edgeFunctions) {
    if (edgeFunctionNames.has(fn.name)) {
      errors.push(`Duplicate edge function name: ${fn.name}`);
    }
    edgeFunctionNames.add(fn.name);
    if (fn.triggers.length === 0) {
      warnings.push(`Edge function '${fn.name}' has no triggers and will never run`);
    }
  }

  return { valid: errors.length === 0, errors, warnings };
}

function validateZone(zone: CdnZoneConfig): string[] {
  const errors: string[] = [];

  if (!zone.domain) {
    errors.push("Zone is missing a domain");
  }
  if (!zone.origin) {
    errors.push(`Zone '${zone.domain}' is missing an origin`);
  }

  const missingBaseline = OWASP_BASELINE_RULE_IDS.filter(
    (id) => !zone.wafRules.some((rule) => rule.id === id),
  );
  if (missingBaseline.length > 0) {
    errors.push(
      `Zone '${zone.domain}' is missing baseline WAF coverage for: ${missingBaseline.join(", ")}`,
    );
  }

  for (const rule of zone.wafRules) {
    if (rule.action === "allow" && OWASP_BASELINE_RULE_IDS.includes(rule.id as any)) {
      errors.push(
        `Zone '${zone.domain}' has baseline rule '${rule.id}' set to 'allow' — it should block or challenge`,
      );
    }
  }

  for (const cacheRule of zone.cacheRules) {
    if (cacheRule.ttl < 0 || cacheRule.browserTtl < 0) {
      errors.push(`Zone '${zone.domain}' has a negative TTL on pattern '${cacheRule.pattern}'`);
    }
  }

  return errors;
}
