/**
 * Secrets management config validation (Issue #97).
 */

import type { SecretConfig, SecretPolicy } from "./secretsManagement.js";

export interface SecretValidationResult {
  valid: boolean;
  errors: string[];
  warnings: string[];
}

const DURATION_PATTERN = /^\d+[smhd]$/;
/** Minimal 5-field cron pattern check (not exhaustive schedule validation,
 * just enough to catch an obviously malformed rotation.interval). */
const CRON_PATTERN = /^(\S+\s+){4}\S+$/;

export function validateSecretConfig(config: SecretConfig): SecretValidationResult {
  const errors: string[] = [];
  const warnings: string[] = [];

  if (!config.path) {
    errors.push("Secret config is missing a path");
  }

  if (!DURATION_PATTERN.test(config.ttl)) {
    errors.push(`Invalid ttl "${config.ttl}": expected a duration like "24h" or "30d"`);
  }

  if (config.maxVersions < 1) {
    errors.push("maxVersions must be at least 1");
  }

  if (config.rotation.enabled) {
    if (!CRON_PATTERN.test(config.rotation.interval)) {
      errors.push(
        `Invalid rotation.interval "${config.rotation.interval}": expected a 5-field cron expression`,
      );
    }
    if (config.type !== "database" && !config.rotation.script) {
      warnings.push(
        `Secret '${config.path}' has rotation enabled but no rotation.script — non-database secret types (${config.type}) typically need a custom rotation script`,
      );
    }
  } else if (config.type === "database") {
    warnings.push(
      `Secret '${config.path}' is type "database" but rotation is disabled — database credentials are usually rotated automatically`,
    );
  }

  for (const policy of config.policies) {
    errors.push(...validatePolicy(config.path, policy));
  }

  if (config.policies.length === 0) {
    warnings.push(`Secret '${config.path}' has no access policies — depending on the backend's default posture this may deny all or allow all access`);
  }

  return { valid: errors.length === 0, errors, warnings };
}

function validatePolicy(secretPath: string, policy: SecretPolicy): string[] {
  const errors: string[] = [];
  if (policy.capabilities.length === 0) {
    errors.push(`Policy on '${policy.path}' for secret '${secretPath}' grants no capabilities`);
  }
  return errors;
}
