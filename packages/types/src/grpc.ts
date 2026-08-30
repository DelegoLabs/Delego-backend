/**
 * gRPC service schema types (Issue #101).
 *
 * Scoping note: this defines the *shape* of a protobuf-style service
 * schema and server/client config so internal services can agree on a
 * contract format ahead of adopting a real gRPC transport. It intentionally
 * does NOT implement protobuf codegen, an actual gRPC server/client, mTLS,
 * a REST gateway, or generated SDKs — those require a toolchain decision
 * (e.g. buf vs protoc, cert issuance strategy) that shouldn't be made
 * unilaterally in this PR. See the PR description for full disclosure.
 */

export type GrpcStreamingMode = "unary" | "server" | "client" | "bidirectional";

export interface GrpcRpcDefinition {
  name: string;
  input: string;
  output: string;
  streaming: GrpcStreamingMode;
}

export interface ProtobufServiceSchema {
  package: string;
  service: string;
  rpcs: GrpcRpcDefinition[];
  options: Record<string, string>;
}

export type GrpcClientAuth = "require" | "verify" | "none";

export interface GrpcServerConfig {
  port: number;
  host: string;
  tls: {
    certFile: string;
    keyFile: string;
    caFile: string;
    clientAuth: GrpcClientAuth;
  };
  interceptors: Array<{
    name: string;
    config: Record<string, unknown>;
  }>;
  maxRecvMsgSize: number;
  maxSendMsgSize: number;
  keepalive: {
    time: string;
    timeout: string;
    permitWithoutStream: boolean;
  };
}

export type GrpcCredentials = "insecure" | "tls" | "mtls";
export type GrpcLoadBalancing = "round_robin" | "pick_first" | "grpclb";

export interface GrpcRetryPolicy {
  maxAttempts: number;
  initialBackoff: string;
  maxBackoff: string;
  backoffMultiplier: number;
  retryableStatusCodes: number[];
}

export interface GrpcClientConfig {
  target: string;
  credentials: GrpcCredentials;
  loadBalancing: GrpcLoadBalancing;
  defaultTimeout: string;
  retryPolicy: GrpcRetryPolicy;
}

/**
 * Validates that a schema's RPC names are unique within the service —
 * the minimum sanity check for a schema before it could be handed to a
 * codegen tool.
 */
export function validateProtobufServiceSchema(schema: ProtobufServiceSchema): string[] {
  const errors: string[] = [];
  const seen = new Set<string>();

  for (const rpc of schema.rpcs) {
    if (seen.has(rpc.name)) {
      errors.push(`Duplicate RPC name: ${rpc.name}`);
    }
    seen.add(rpc.name);
  }

  if (schema.rpcs.length === 0) {
    errors.push("Service schema must declare at least one RPC");
  }

  return errors;
}
