/**
 * Service mesh (traffic management / mTLS) configuration types (Issue #98).
 *
 * Scoping note: this defines a provider-agnostic config schema and a
 * validator so a mesh configuration (traffic splitting, circuit breaking,
 * authorization policy) can be reviewed and tested before being applied.
 * It intentionally does NOT deploy an actual Istio/Linkerd control plane,
 * issue mTLS certificates, or configure a real Kubernetes cluster —
 * choosing a mesh provider and migration plan for existing services is an
 * infra decision that shouldn't be made unilaterally in this PR.
 */

export type MeshProvider = "istio" | "linkerd";
export type MtlsMode = "strict" | "permissive" | "disabled";

export interface ServiceMeshConfig {
  provider: MeshProvider;
  mtlsMode: MtlsMode;
  controlPlane: {
    replicas: number;
    resources: { cpu: string; memory: string };
  };
  ingressGateway: {
    enabled: boolean;
    ports: Array<{ port: number; protocol: string }>;
  };
  egressGateway: {
    enabled: boolean;
  };
}

export interface TrafficRouteDestination {
  destination: { host: string; subset?: string };
  weight: number;
}

export interface CircuitBreakerConfig {
  consecutive5xxErrors: number;
  interval: string;
  baseEjectionTime: string;
  maxEjectionPercent: number;
}

export interface TrafficRule {
  match: { headers: Record<string, string> };
  route: TrafficRouteDestination[];
  retries: {
    attempts: number;
    perTryTimeout: string;
    retryOn: string;
  };
  timeout: string;
  circuitBreaker: CircuitBreakerConfig;
}

export interface TrafficPolicy {
  destination: string;
  rules: TrafficRule[];
}

export interface AuthorizationRule {
  from: Array<{ source: { principals: string[] } }>;
  to: Array<{ operation: { methods: string[]; paths: string[] } }>;
  when: Array<{ key: string; values: string[] }>;
}

export interface AuthorizationPolicy {
  namespace: string;
  rules: AuthorizationRule[];
}
