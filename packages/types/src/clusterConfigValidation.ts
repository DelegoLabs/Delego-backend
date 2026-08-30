/**
 * Cluster / GitOps config validation (Issue #95).
 */

import type { ClusterConfig, ClusterHealth, GitOpsConfig, NodePoolConfig } from "./clusterConfig.js";

export interface ClusterValidationResult {
  valid: boolean;
  errors: string[];
  warnings: string[];
}

const CIDR_PATTERN = /^\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}\/\d{1,2}$/;

export function validateClusterConfig(config: ClusterConfig): ClusterValidationResult {
  const errors: string[] = [];
  const warnings: string[] = [];

  if (config.nodePools.length === 0) {
    errors.push("Cluster config must declare at least one node pool");
  }

  for (const pool of config.nodePools) {
    errors.push(...validateNodePool(pool));
  }

  const systemPool = config.nodePools.find((p) => p.labels["pool-type"] === "system");
  if (!systemPool) {
    warnings.push(
      "No node pool labeled pool-type=system found — system workloads may be scheduled onto general-purpose nodes",
    );
  }

  if (!CIDR_PATTERN.test(config.networking.cidr)) {
    errors.push(`Invalid networking.cidr "${config.networking.cidr}"`);
  }
  if (!CIDR_PATTERN.test(config.networking.serviceCidr)) {
    errors.push(`Invalid networking.serviceCidr "${config.networking.serviceCidr}"`);
  }
  if (config.networking.subnets.length === 0) {
    errors.push("Cluster config must declare at least one subnet");
  }

  return { valid: errors.length === 0, errors, warnings };
}

function validateNodePool(pool: NodePoolConfig): string[] {
  const errors: string[] = [];
  if (pool.minSize < 0) {
    errors.push(`Node pool '${pool.name}' has a negative minSize`);
  }
  if (pool.maxSize < pool.minSize) {
    errors.push(`Node pool '${pool.name}' has maxSize (${pool.maxSize}) less than minSize (${pool.minSize})`);
  }
  return errors;
}

export function validateGitOpsConfig(config: GitOpsConfig): ClusterValidationResult {
  const errors: string[] = [];
  const warnings: string[] = [];

  if (!config.repoUrl) {
    errors.push("GitOps config is missing a repoUrl");
  }
  if (!config.branch) {
    errors.push("GitOps config is missing a branch");
  }

  if (config.syncPolicy === "automatic" && !config.selfHeal) {
    warnings.push(
      "syncPolicy is 'automatic' but selfHeal is disabled — manual drift (kubectl edit, etc.) won't be auto-corrected",
    );
  }
  if (config.syncPolicy === "manual" && config.prune) {
    warnings.push(
      "syncPolicy is 'manual' but prune is enabled — pruning normally pairs with automatic sync; verify this is intentional",
    );
  }

  return { valid: errors.length === 0, errors, warnings };
}

/** Assess whether a cluster's health snapshot indicates it is in a
 * production-ready steady state. */
export function isClusterHealthy(health: ClusterHealth): boolean {
  return (
    health.nodesReady === health.nodesTotal &&
    health.podsRunning === health.podsTotal &&
    health.podDisruptionBudgetsMet &&
    health.cpuUtilization < 90 &&
    health.memoryUtilization < 90
  );
}
