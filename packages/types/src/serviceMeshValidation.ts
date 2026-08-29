/**
 * Service mesh config validation (Issue #98).
 */

import type { AuthorizationPolicy, ServiceMeshConfig, TrafficPolicy } from "./serviceMesh.js";

export interface MeshValidationResult {
  valid: boolean;
  errors: string[];
  warnings: string[];
}

export function validateServiceMeshConfig(config: ServiceMeshConfig): MeshValidationResult {
  const errors: string[] = [];
  const warnings: string[] = [];

  if (config.mtlsMode === "disabled") {
    errors.push("mTLS is disabled — service-to-service traffic would be unencrypted");
  } else if (config.mtlsMode === "permissive") {
    warnings.push(
      "mTLS is permissive (accepts both mTLS and plaintext) — this should only be used during migration, not as a steady state",
    );
  }

  if (config.controlPlane.replicas < 2) {
    warnings.push("Control plane has fewer than 2 replicas — a single control plane instance is a single point of failure");
  }

  if (config.ingressGateway.enabled && config.ingressGateway.ports.length === 0) {
    errors.push("Ingress gateway is enabled but declares no ports");
  }

  return { valid: errors.length === 0, errors, warnings };
}

export function validateTrafficPolicy(policy: TrafficPolicy): MeshValidationResult {
  const errors: string[] = [];
  const warnings: string[] = [];

  for (const [i, rule] of policy.rules.entries()) {
    const totalWeight = rule.route.reduce((sum, r) => sum + r.weight, 0);
    if (totalWeight !== 100) {
      errors.push(
        `Rule ${i} for '${policy.destination}': route weights sum to ${totalWeight}, expected 100`,
      );
    }

    if (rule.route.some((r) => r.weight < 0)) {
      errors.push(`Rule ${i} for '${policy.destination}': route weights must not be negative`);
    }

    if (rule.circuitBreaker.consecutive5xxErrors <= 0) {
      errors.push(
        `Rule ${i} for '${policy.destination}': circuitBreaker.consecutive5xxErrors must be positive`,
      );
    }

    if (rule.circuitBreaker.maxEjectionPercent > 100) {
      errors.push(
        `Rule ${i} for '${policy.destination}': circuitBreaker.maxEjectionPercent cannot exceed 100`,
      );
    }

    if (rule.retries.attempts === 0) {
      warnings.push(
        `Rule ${i} for '${policy.destination}' has 0 retry attempts — transient failures won't be retried`,
      );
    }
  }

  return { valid: errors.length === 0, errors, warnings };
}

export function validateAuthorizationPolicy(policy: AuthorizationPolicy): MeshValidationResult {
  const errors: string[] = [];
  const warnings: string[] = [];

  if (policy.rules.length === 0) {
    warnings.push(
      `Authorization policy for namespace '${policy.namespace}' has no rules — depending on the mesh's default-deny/default-allow posture, this may allow or block all traffic`,
    );
  }

  for (const [i, rule] of policy.rules.entries()) {
    if (rule.from.some((f) => f.source.principals.includes("*"))) {
      warnings.push(
        `Rule ${i} in namespace '${policy.namespace}' allows principal "*" — this is broader than least-privilege`,
      );
    }
    if (rule.to.some((t) => t.operation.methods.length === 0)) {
      errors.push(`Rule ${i} in namespace '${policy.namespace}' declares an operation with no methods`);
    }
  }

  return { valid: errors.length === 0, errors, warnings };
}
