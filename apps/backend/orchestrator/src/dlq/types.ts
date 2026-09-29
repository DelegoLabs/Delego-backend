/**
 * Dead Letter Queue (DLQ) types for BullMQ job replay
 * Issue #310
 */

export interface DeadLetterJobRecord {
  jobId: string;
  queueName: string;
  failedReason: string;
  attemptsMade: number;
  payload: Record<string, unknown>;
  failedAt: string;
}

export interface DLQJobRow {
  id: string;
  job_id: string;
  queue_name: string;
  failed_reason: string;
  attempts_made: number;
  payload: Record<string, unknown>;
  failed_at: Date;
  replayed_at: Date | null;
  replay_count: number;
  status: 'pending' | 'replaying' | 'replayed' | 'failed';
  created_at: Date;
  updated_at: Date;
}

export interface CircuitBreakerConfig {
  failureThreshold: number;
  successThreshold: number;
  timeout: number;
}

export interface CircuitBreakerState {
  state: 'CLOSED' | 'OPEN' | 'HALF_OPEN';
  failures: number;
  successes: number;
  lastFailureTime: number | null;
  nextAttemptTime: number | null;
}

export interface ReplayResult {
  success: boolean;
  jobId: string;
  queueName: string;
  error?: string;
}

export interface ReplayRequest {
  jobIds?: string[];
  queueName?: string;
  maxRetries?: number;
}
