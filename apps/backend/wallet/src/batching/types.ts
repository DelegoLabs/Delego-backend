/**
 * Transaction Batching for Gas Optimization — shared types
 * Issue #42 + Issue #142 (Enhancements)
 */

export interface BatchTransactionItem {
  sourceAddress: string;
  contractId: string;
  method: string;
  args: unknown[];
  memo: string;
  userId: string;
  /** If false, failure of this operation does not fail the entire batch */
  required?: boolean;
}

export type BatchPriority = "low" | "normal" | "high";

export interface BatchTransactionRequest {
  transactions: BatchTransactionItem[];
  priority: BatchPriority;
  /** Ledger at which to execute the batch (optional scheduling) */
  executeAtLedger?: number;
  /** Maximum gas in stroops for the entire batch */
  maxGasStroops?: string;
}

export type BatchStatus =
  | "queued"
  | "scheduled"
  | "processing"
  | "executing"
  | "completed"
  | "partial_failure"
  | "failed"
  | "rolled_back";

export interface BatchTransactionResponse {
  batchId: string;
  status: BatchStatus;
  submittedAt: string; // ISO 8601
  estimatedCompletion: string; // ISO 8601
}

export interface BatchItemResult {
  userId: string;
  success: boolean;
  hash: string | null;
  error: string | null;
  ledger: number | null;
  gasUsed?: string;
  index: number;
}

export interface BatchTransactionResult {
  batchId: string;
  transactionHash: string | null;
  results: BatchItemResult[];
  gasUsed: string; // stroops
  gasSaved: string; // stroops
  totalGasSaved: string;
  status: BatchStatus;
  completedAt: string | null;
  executedAtLedger?: number;
}

export interface BatchStatusResponse {
  batchId: string;
  status: BatchStatus;
  progress: number; // 0-100
  estimatedCompletion: string;
  operationsTotal: number;
  operationsCompleted: number;
}

/** Per-operation gas estimation */
export interface OperationGasEstimate {
  index: number;
  contractId: string;
  method: string;
  estimatedGasStroops: string;
  required: boolean;
}
