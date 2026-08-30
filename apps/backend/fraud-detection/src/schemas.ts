/**
 * Fraud detection API schemas
 */

export interface Address {
  street: string;
  city: string;
  state: string;
  postalCode: string;
  country: string;
}

export interface FraudCheckRequest {
  transactionId: string;
  customerId: string;
  paymentMethodId: string;
  amount: string;
  currency: string;
  ipAddress: string;
  deviceFingerprint: string;
  email: string;
  billingAddress: Address;
  shippingAddress?: Address;
  metadata: Record<string, unknown>;
}

export interface FraudCheckResponse {
  transactionId: string;
  score: number;
  riskLevel: "low" | "medium" | "high" | "critical";
  factors: Array<{
    name: string;
    value: unknown;
    weight: number;
    contribution: number;
  }>;
  rulesTriggered: string[];
  recommendation: "approve" | "review" | "decline";
  modelVersion: string;
  scoredAt: string;
  reviewRequired: boolean;
}

export interface FraudRule {
  id: string;
  name: string;
  description: string;
  condition: string; // expression
  action: "flag" | "review" | "block";
  scoreImpact: number;
  enabled: boolean;
  metadata: Record<string, unknown>;
  createdAt?: string;
  updatedAt?: string;
}

export interface CreateFraudRuleRequest {
  name: string;
  description: string;
  condition: string;
  action: "flag" | "review" | "block";
  scoreImpact: number;
  enabled?: boolean;
  metadata?: Record<string, unknown>;
}

export interface UpdateFraudRuleRequest {
  name?: string;
  description?: string;
  condition?: string;
  action?: "flag" | "review" | "block";
  scoreImpact?: number;
  enabled?: boolean;
  metadata?: Record<string, unknown>;
}

export interface FraudCase {
  id: string;
  transactionId: string;
  status: "open" | "investigating" | "confirmed_fraud" | "false_positive" | "closed";
  assignedTo?: string;
  priority: "low" | "medium" | "high" | "urgent";
  evidence: Array<{
    type: string;
    data: Record<string, unknown>;
    addedAt: string;
    addedBy: string;
  }>;
  resolution?: {
    outcome: "fraud" | "legitimate";
    actionTaken: string;
    resolvedAt: string;
    resolvedBy: string;
  };
  createdAt?: string;
  updatedAt?: string;
}

export interface CreateFraudCaseRequest {
  transactionId: string;
  priority?: "low" | "medium" | "high" | "urgent";
  assignedTo?: string;
}

export interface UpdateFraudCaseRequest {
  status?: "open" | "investigating" | "confirmed_fraud" | "false_positive" | "closed";
  priority?: "low" | "medium" | "high" | "urgent";
  assignedTo?: string;
}

export interface AddEvidenceRequest {
  type: string;
  data: Record<string, unknown>;
  addedBy: string;
}

export interface FraudCaseResponse {
  id: string;
  transactionId: string;
  status: "open" | "investigating" | "confirmed_fraud" | "false_positive" | "closed";
  assignedTo?: string;
  priority: "low" | "medium" | "high" | "urgent";
  evidence: Array<{
    type: string;
    data: Record<string, unknown>;
    addedAt: string;
    addedBy: string;
  }>;
  resolution?: {
    outcome: "fraud" | "legitimate";
    actionTaken: string;
    resolvedAt: string;
    resolvedBy: string;
  };
  createdAt: string;
  updatedAt: string;
}

export interface ModelPerformance {
  precision: number;
  recall: number;
  f1Score: number;
  accuracy: number;
  falsePositiveRate: number;
  fraudDetected: number;
  totalTransactions: number;
  lastRetrained: string;
}

export interface RetrainModelResponse {
  status: "queued" | "running" | "completed" | "failed";
  modelVersion: string;
  metrics: ModelPerformance;
  errorMessage?: string;
}

export interface AnalyticsMetrics {
  totalTransactions: number;
  flaggedTransactions: number;
  fraudConfirmed: number;
  fraudRate: number;
  averageScore: number;
  byTimePeriod: Array<{
    period: string;
    total: number;
    flagged: number;
    fraud: number;
  }>;
  byChannel: Array<{
    channel: string;
    total: number;
    flagged: number;
    fraud: number;
  }>;
}
