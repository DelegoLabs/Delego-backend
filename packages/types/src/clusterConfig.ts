/**
 * Production Kubernetes cluster / GitOps configuration types (Issue #95).
 *
 * Scoping note: this defines a provider-agnostic cluster and GitOps config
 * schema plus a validator, so a cluster's node pool sizing, networking,
 * and GitOps sync policy can be reviewed before being applied. It
 * intentionally does NOT provision an actual EKS/GKE/AKS cluster, install
 * ArgoCD/Flux, or configure a CSI/Vault secrets sync — those require real
 * cloud provider access and an infra decision that shouldn't be made
 * unilaterally in this PR.
 */

export interface NodeTaint {
  key: string;
  value: string;
  effect: string;
}

export interface NodePoolConfig {
  name: string;
  instanceType: string;
  minSize: number;
  maxSize: number;
  labels: Record<string, string>;
  taints: NodeTaint[];
}

export interface ClusterNetworking {
  vpcId: string;
  subnets: string[];
  cidr: string;
  serviceCidr: string;
}

export interface ClusterConfig {
  name: string;
  region: string;
  version: string;
  nodePools: NodePoolConfig[];
  networking: ClusterNetworking;
  addons: string[];
}

export type GitOpsSyncPolicy = "automatic" | "manual";

export interface GitOpsConfig {
  repoUrl: string;
  path: string;
  branch: string;
  syncPolicy: GitOpsSyncPolicy;
  prune: boolean;
  selfHeal: boolean;
}

export interface ClusterHealth {
  nodesReady: number;
  nodesTotal: number;
  podsRunning: number;
  podsTotal: number;
  cpuUtilization: number;
  memoryUtilization: number;
  podDisruptionBudgetsMet: boolean;
}
