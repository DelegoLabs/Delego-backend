/**
 * Pact Contract Testing Types
 * Issue #88
 */

export interface PactInteractionRequest {
  method: string;
  path: string;
  headers: Record<string, string>;
  body: unknown;
  query: Record<string, string>;
}

export interface PactInteractionResponse {
  status: number;
  headers: Record<string, string>;
  body: unknown;
}

export interface PactProviderState {
  name: string;
  params: Record<string, unknown>;
}

export interface PactInteraction {
  description: string;
  request: PactInteractionRequest;
  response: PactInteractionResponse;
  providerStates: PactProviderState[];
}

export interface PactContract {
  consumer: string;
  provider: string;
  interactions: PactInteraction[];
  metadata: {
    pactSpecification: string;
    timestamp: string;
  };
}

export interface ContractVerificationResult {
  provider: string;
  version: string;
  success: boolean;
  verifiedInteractions: number;
  failedInteractions: Array<{
    interaction: string;
    error: string;
  }>;
  verificationDate: string;
}

export interface CanIDeployResult {
  version: string;
  canDeploy: boolean;
  missingVerifications: Array<{
    consumer: string;
    consumerVersion: string;
  }>;
}
