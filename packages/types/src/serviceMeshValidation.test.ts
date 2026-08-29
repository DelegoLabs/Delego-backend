import { describe, it, expect } from "vitest";
import {
  validateServiceMeshConfig,
  validateTrafficPolicy,
  validateAuthorizationPolicy,
} from "./serviceMeshValidation.js";
import type { AuthorizationPolicy, ServiceMeshConfig, TrafficPolicy } from "./serviceMesh.js";

function buildMeshConfig(overrides: Partial<ServiceMeshConfig> = {}): ServiceMeshConfig {
  return {
    provider: "istio",
    mtlsMode: "strict",
    controlPlane: { replicas: 3, resources: { cpu: "500m", memory: "512Mi" } },
    ingressGateway: { enabled: true, ports: [{ port: 443, protocol: "HTTPS" }] },
    egressGateway: { enabled: false },
    ...overrides,
  };
}

describe("validateServiceMeshConfig", () => {
  it("passes a strict-mTLS config with a resilient control plane", () => {
    const result = validateServiceMeshConfig(buildMeshConfig());
    expect(result.valid).toBe(true);
    expect(result.errors).toEqual([]);
  });

  it("fails when mTLS is disabled", () => {
    const result = validateServiceMeshConfig(buildMeshConfig({ mtlsMode: "disabled" }));
    expect(result.valid).toBe(false);
    expect(result.errors[0]).toMatch(/mTLS is disabled/);
  });

  it("warns (but does not fail) when mTLS is permissive", () => {
    const result = validateServiceMeshConfig(buildMeshConfig({ mtlsMode: "permissive" }));
    expect(result.valid).toBe(true);
    expect(result.warnings.some((w) => w.includes("permissive"))).toBe(true);
  });

  it("warns when the control plane has fewer than 2 replicas", () => {
    const result = validateServiceMeshConfig(
      buildMeshConfig({ controlPlane: { replicas: 1, resources: { cpu: "500m", memory: "512Mi" } } }),
    );
    expect(result.warnings.some((w) => w.includes("single point of failure"))).toBe(true);
  });

  it("fails when the ingress gateway is enabled with no ports", () => {
    const result = validateServiceMeshConfig(buildMeshConfig({ ingressGateway: { enabled: true, ports: [] } }));
    expect(result.errors.some((e) => e.includes("no ports"))).toBe(true);
  });
});

describe("validateTrafficPolicy", () => {
  function buildPolicy(overrides: Partial<TrafficPolicy> = {}): TrafficPolicy {
    return {
      destination: "orders-service",
      rules: [
        {
          match: { headers: {} },
          route: [{ destination: { host: "orders-v1" }, weight: 90 }, { destination: { host: "orders-v2" }, weight: 10 }],
          retries: { attempts: 3, perTryTimeout: "2s", retryOn: "5xx" },
          timeout: "10s",
          circuitBreaker: { consecutive5xxErrors: 5, interval: "30s", baseEjectionTime: "30s", maxEjectionPercent: 50 },
        },
      ],
      ...overrides,
    };
  }

  it("passes a policy whose route weights sum to 100", () => {
    const result = validateTrafficPolicy(buildPolicy());
    expect(result.valid).toBe(true);
  });

  it("fails when route weights do not sum to 100", () => {
    const policy = buildPolicy({
      rules: [
        {
          match: { headers: {} },
          route: [{ destination: { host: "v1" }, weight: 90 }, { destination: { host: "v2" }, weight: 5 }],
          retries: { attempts: 3, perTryTimeout: "2s", retryOn: "5xx" },
          timeout: "10s",
          circuitBreaker: { consecutive5xxErrors: 5, interval: "30s", baseEjectionTime: "30s", maxEjectionPercent: 50 },
        },
      ],
    });
    const result = validateTrafficPolicy(policy);
    expect(result.valid).toBe(false);
    expect(result.errors[0]).toMatch(/sum to 95/);
  });

  it("fails when circuitBreaker.maxEjectionPercent exceeds 100", () => {
    const policy = buildPolicy();
    policy.rules[0].circuitBreaker.maxEjectionPercent = 150;
    const result = validateTrafficPolicy(policy);
    expect(result.valid).toBe(false);
  });

  it("fails when consecutive5xxErrors is not positive", () => {
    const policy = buildPolicy();
    policy.rules[0].circuitBreaker.consecutive5xxErrors = 0;
    const result = validateTrafficPolicy(policy);
    expect(result.valid).toBe(false);
  });

  it("warns when retry attempts is 0", () => {
    const policy = buildPolicy();
    policy.rules[0].retries.attempts = 0;
    const result = validateTrafficPolicy(policy);
    expect(result.valid).toBe(true);
    expect(result.warnings.some((w) => w.includes("0 retry attempts"))).toBe(true);
  });
});

describe("validateAuthorizationPolicy", () => {
  function buildAuthzPolicy(overrides: Partial<AuthorizationPolicy> = {}): AuthorizationPolicy {
    return {
      namespace: "payments",
      rules: [
        {
          from: [{ source: { principals: ["cluster.local/ns/gateway/sa/gateway"] } }],
          to: [{ operation: { methods: ["GET"], paths: ["/api/v1/orders"] } }],
          when: [],
        },
      ],
      ...overrides,
    };
  }

  it("passes a least-privilege policy", () => {
    const result = validateAuthorizationPolicy(buildAuthzPolicy());
    expect(result.valid).toBe(true);
    expect(result.warnings).toEqual([]);
  });

  it("warns when a policy has no rules", () => {
    const result = validateAuthorizationPolicy(buildAuthzPolicy({ rules: [] }));
    expect(result.warnings.length).toBeGreaterThan(0);
  });

  it("warns when a rule allows the wildcard principal", () => {
    const policy = buildAuthzPolicy();
    policy.rules[0].from[0].source.principals = ["*"];
    const result = validateAuthorizationPolicy(policy);
    expect(result.warnings.some((w) => w.includes('principal "*"'))).toBe(true);
  });

  it("fails when an operation declares no methods", () => {
    const policy = buildAuthzPolicy();
    policy.rules[0].to[0].operation.methods = [];
    const result = validateAuthorizationPolicy(policy);
    expect(result.valid).toBe(false);
  });
});
