/**
 * DLQ Service - handles replay logic with circuit breaker
 * Issue #310
 */

import { Queue } from 'bullmq';
import type { ConnectionOptions } from 'bullmq';
import { CircuitBreaker } from './circuitBreaker.js';
import { DLQStore } from './store.js';
import type { DeadLetterJobRecord, ReplayResult, ReplayRequest } from './types.js';

export class DLQService {
  private queues: Map<string, Queue> = new Map();
  private circuitBreakers: Map<string, CircuitBreaker> = new Map();

  constructor(
    private store: DLQStore,
    private redisConnection: ConnectionOptions,
    private log: { info: (msg: string, meta?: any) => void; warn: (msg: string, meta?: any) => void; error: (msg: string, meta?: any) => void }
  ) {}

  /**
   * Replay a single job
   */
  async replayJob(job: DeadLetterJobRecord): Promise<ReplayResult> {
    const { jobId, queueName, payload } = job;

    try {
      // Get or create circuit breaker for this queue
      const breaker = this.getCircuitBreaker(queueName);

      // Mark as replaying
      await this.store.markReplaying(jobId, queueName);

      // Execute replay through circuit breaker
      await breaker.execute(async () => {
        const queue = this.getQueue(queueName);
        
        // Check if job already exists in the queue (avoid duplicates)
        const existingJob = await queue.getJob(jobId);
        if (existingJob) {
          const state = await existingJob.getState();
          if (state === 'completed') {
            this.log.info('Job already completed, skipping replay', { jobId, queueName });
            return;
          }
        }

        // Re-enqueue the job with the original payload
        await queue.add(
          payload.name as string || 'dlq-replay',
          payload,
          {
            jobId, // Preserve original job ID to prevent duplicates
            attempts: 3,
            backoff: {
              type: 'exponential',
              delay: 5000,
            },
          }
        );
      });

      // Mark as successfully replayed
      await this.store.markReplayed(jobId, queueName);

      this.log.info('Job replayed successfully', { jobId, queueName });

      return {
        success: true,
        jobId,
        queueName,
      };
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      
      // Mark as failed
      await this.store.markFailed(jobId, queueName, errorMessage);

      this.log.error('Job replay failed', { jobId, queueName, error: errorMessage });

      return {
        success: false,
        jobId,
        queueName,
        error: errorMessage,
      };
    }
  }

  /**
   * Replay multiple jobs based on request
   */
  async replayJobs(request: ReplayRequest): Promise<ReplayResult[]> {
    let jobs: DeadLetterJobRecord[];

    if (request.jobIds && request.jobIds.length > 0) {
      // Replay specific jobs
      jobs = await this.store.getJobsByIds(request.jobIds);
    } else if (request.queueName) {
      // Replay all pending jobs for a specific queue
      jobs = await this.store.getPendingJobs(request.queueName, request.maxRetries ?? 100);
    } else {
      // Replay all pending jobs
      jobs = await this.store.getPendingJobs(undefined, request.maxRetries ?? 100);
    }

    if (jobs.length === 0) {
      this.log.info('No jobs to replay', request);
      return [];
    }

    this.log.info('Starting job replay', { count: jobs.length, request });

    const results: ReplayResult[] = [];

    // Replay jobs sequentially to avoid overwhelming the system
    for (const job of jobs) {
      const result = await this.replayJob(job);
      results.push(result);

      // If circuit breaker is open, stop replaying for this queue
      const breaker = this.getCircuitBreaker(job.queueName);
      if (breaker.getState().state === 'OPEN') {
        this.log.warn('Circuit breaker opened, stopping replay for queue', {
          queueName: job.queueName,
          state: breaker.getState(),
        });
        break;
      }
    }

    const successful = results.filter((r) => r.success).length;
    const failed = results.filter((r) => !r.success).length;

    this.log.info('Job replay completed', { total: results.length, successful, failed });

    return results;
  }

  /**
   * Auto-replay jobs with recoverable network errors
   */
  async autoReplayRecoverableJobs(limit = 100): Promise<ReplayResult[]> {
    const jobs = await this.store.getRecoverableJobs(limit);

    if (jobs.length === 0) {
      return [];
    }

    this.log.info('Auto-replaying recoverable jobs', { count: jobs.length });

    return this.replayJobs({ jobIds: jobs.map((j) => j.jobId) });
  }

  /**
   * Get circuit breaker state for a queue
   */
  getCircuitBreakerState(queueName: string) {
    const breaker = this.circuitBreakers.get(queueName);
    return breaker ? breaker.getState() : null;
  }

  /**
   * Reset circuit breaker for a queue
   */
  resetCircuitBreaker(queueName: string): void {
    const breaker = this.circuitBreakers.get(queueName);
    if (breaker) {
      breaker.reset();
      this.log.info('Circuit breaker reset', { queueName });
    }
  }

  private getQueue(queueName: string): Queue {
    let queue = this.queues.get(queueName);
    if (!queue) {
      queue = new Queue(queueName, { connection: this.redisConnection });
      this.queues.set(queueName, queue);
    }
    return queue;
  }

  private getCircuitBreaker(queueName: string): CircuitBreaker {
    let breaker = this.circuitBreakers.get(queueName);
    if (!breaker) {
      breaker = new CircuitBreaker({
        failureThreshold: 5,
        successThreshold: 2,
        timeout: 60000, // 1 minute
      });
      this.circuitBreakers.set(queueName, breaker);
    }
    return breaker;
  }

  /**
   * Cleanup resources
   */
  async close(): Promise<void> {
    for (const queue of this.queues.values()) {
      await queue.close();
    }
    this.queues.clear();
    this.circuitBreakers.clear();
  }
}
