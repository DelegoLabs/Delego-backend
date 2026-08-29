import { describe, it, expect } from "vitest";
import { validateClusterConfig, validateGitOpsConfig, isClusterHealthy } from "./clusterConfigValidation.js";
import type { ClusterConfig, ClusterHealth, GitOpsConfig, NodePoolConfig } from "./clusterConfig.js";

function buildNodePool(overrides: Partial<NodePoolConfig> = {}): NodePoolConfig {
  return {
    name: "system",
    instanceType: "t3.medium",
    minSize: 2,
    maxSize: 5,
    labels: { "pool-type": "system" },
    taints: [],
    ...overrides,
  };
}

function buildClusterConfig(overrides: Partial<ClusterConfig> = {}): ClusterConfig {
  return {
    name: "delego-prod",
    region: "us-east-1",
    version: "1.29",
    nodePools: [buildNodePool()],
    networking: { vpcId: "vpc-1", subnets: ["subnet-1", "subnet-2"], cidr: "10.0.0.0/16", serviceCidr: "10.100.0.0/16" },
    addons: [],
    ...overrides,
  };
}

describe("validateClusterConfig", () => {
  it("passes a well-formed config with a system node pool", () => {
    expect(validateClusterConfig(buildClusterConfig()).valid).toBe(true);
  });

  it("fails a config with no node pools", () => {
    const result = validateClusterConfig(buildClusterConfig({ nodePools: [] }));
    expect(result.valid).toBe(false);
  });

  it("fails a node pool with maxSize less than minSize", () => {
    const config = buildClusterConfig({ nodePools: [buildNodePool({ minSize: 5, maxSize: 2 })] });
    expect(validateClusterConfig(config).valid).toBe(false);
  });

  it("fails a node pool with negative minSize", () => {
    const config = buildClusterConfig({ nodePools: [buildNodePool({ minSize: -1 })] });
    expect(validateClusterConfig(config).valid).toBe(false);
  });

  it("warns when no node pool is labeled pool-type=system", () => {
    const config = buildClusterConfig({ nodePools: [buildNodePool({ labels: {} })] });
    const result = validateClusterConfig(config);
    expect(result.valid).toBe(true);
    expect(result.warnings.length).toBeGreaterThan(0);
  });

  it("fails an invalid CIDR", () => {
    const config = buildClusterConfig({
      networking: { vpcId: "vpc-1", subnets: ["s1"], cidr: "not-a-cidr", serviceCidr: "10.100.0.0/16" },
    });
    expect(validateClusterConfig(config).valid).toBe(false);
  });

  it("fails a config with no subnets", () => {
    const config = buildClusterConfig({
      networking: { vpcId: "vpc-1", subnets: [], cidr: "10.0.0.0/16", serviceCidr: "10.100.0.0/16" },
    });
    expect(validateClusterConfig(config).valid).toBe(false);
  });
});

describe("validateGitOpsConfig", () => {
  function buildGitOps(overrides: Partial<GitOpsConfig> = {}): GitOpsConfig {
    return {
      repoUrl: "https://github.com/delegolabs/gitops",
      path: "clusters/prod",
      branch: "main",
      syncPolicy: "automatic",
      prune: true,
      selfHeal: true,
      ...overrides,
    };
  }

  it("passes a well-formed automatic-sync config", () => {
    expect(validateGitOpsConfig(buildGitOps()).valid).toBe(true);
  });

  it("fails a config missing repoUrl", () => {
    expect(validateGitOpsConfig(buildGitOps({ repoUrl: "" })).valid).toBe(false);
  });

  it("fails a config missing branch", () => {
    expect(validateGitOpsConfig(buildGitOps({ branch: "" })).valid).toBe(false);
  });

  it("warns when automatic sync has selfHeal disabled", () => {
    const result = validateGitOpsConfig(buildGitOps({ selfHeal: false }));
    expect(result.valid).toBe(true);
    expect(result.warnings.some((w) => w.includes("selfHeal"))).toBe(true);
  });

  it("warns when manual sync has prune enabled", () => {
    const result = validateGitOpsConfig(buildGitOps({ syncPolicy: "manual", prune: true }));
    expect(result.warnings.some((w) => w.includes("prune"))).toBe(true);
  });
});

describe("isClusterHealthy", () => {
  function buildHealth(overrides: Partial<ClusterHealth> = {}): ClusterHealth {
    return {
      nodesReady: 5,
      nodesTotal: 5,
      podsRunning: 40,
      podsTotal: 40,
      cpuUtilization: 50,
      memoryUtilization: 60,
      podDisruptionBudgetsMet: true,
      ...overrides,
    };
  }

  it("reports healthy when all conditions are met", () => {
    expect(isClusterHealthy(buildHealth())).toBe(true);
  });

  it("reports unhealthy when a node is not ready", () => {
    expect(isClusterHealthy(buildHealth({ nodesReady: 4 }))).toBe(false);
  });

  it("reports unhealthy when a pod is not running", () => {
    expect(isClusterHealthy(buildHealth({ podsRunning: 38 }))).toBe(false);
  });

  it("reports unhealthy when PDBs are not met", () => {
    expect(isClusterHealthy(buildHealth({ podDisruptionBudgetsMet: false }))).toBe(false);
  });

  it("reports unhealthy when CPU utilization is at or above 90%", () => {
    expect(isClusterHealthy(buildHealth({ cpuUtilization: 90 }))).toBe(false);
  });

  it("reports unhealthy when memory utilization is at or above 90%", () => {
    expect(isClusterHealthy(buildHealth({ memoryUtilization: 95 }))).toBe(false);
  });
});
