/**
 * PostgreSQL store for Dead Letter Queue
 * Issue #310
 */

import type { Pool } from 'pg';
import type { DeadLetterJobRecord, DLQJobRow } from './types.js';

export class DLQStore {
  constructor(private pool: Pool) {}

  /**
   * Add a failed job to the DLQ
   */
  async addJob(job: DeadLetterJobRecord): Promise<void> {
    await this.pool.query(
      `INSERT INTO orchestrator_dead_letter_queue 
       (job_id, queue_name, failed_reason, attempts_made, payload, failed_at, status, created_at, updated_at)
       VALUES ($1, $2, $3, $4, $5, $6, 'pending', NOW(), NOW())
       ON CONFLICT (job_id, queue_name) DO UPDATE
       SET failed_reason = EXCLUDED.failed_reason,
           attempts_made = EXCLUDED.attempts_made,
           payload = EXCLUDED.payload,
           failed_at = EXCLUDED.failed_at,
           updated_at = NOW()`,
      [
        job.jobId,
        job.queueName,
        job.failedReason,
        job.attemptsMade,
        JSON.stringify(job.payload),
        job.failedAt,
      ]
    );
  }

  /**
   * Get pending jobs for replay (recoverable network errors)
   */
  async getPendingJobs(queueName?: string, limit = 100): Promise<DeadLetterJobRecord[]> {
    const query = queueName
      ? `SELECT * FROM orchestrator_dead_letter_queue 
         WHERE status = 'pending' AND queue_name = $1
         ORDER BY failed_at ASC
         LIMIT $2`
      : `SELECT * FROM orchestrator_dead_letter_queue 
         WHERE status = 'pending'
         ORDER BY failed_at ASC
         LIMIT $1`;

    const params = queueName ? [queueName, limit] : [limit];
    const result = await this.pool.query<DLQJobRow>(query, params);

    return result.rows.map(this.rowToRecord);
  }

  /**
   * Get jobs by specific job IDs
   */
  async getJobsByIds(jobIds: string[]): Promise<DeadLetterJobRecord[]> {
    if (jobIds.length === 0) return [];

    const result = await this.pool.query<DLQJobRow>(
      `SELECT * FROM orchestrator_dead_letter_queue 
       WHERE job_id = ANY($1) AND status = 'pending'
       ORDER BY failed_at ASC`,
      [jobIds]
    );

    return result.rows.map(this.rowToRecord);
  }

  /**
   * Mark a job as being replayed
   */
  async markReplaying(jobId: string, queueName: string): Promise<void> {
    await this.pool.query(
      `UPDATE orchestrator_dead_letter_queue 
       SET status = 'replaying', updated_at = NOW()
       WHERE job_id = $1 AND queue_name = $2`,
      [jobId, queueName]
    );
  }

  /**
   * Mark a job as successfully replayed
   */
  async markReplayed(jobId: string, queueName: string): Promise<void> {
    await this.pool.query(
      `UPDATE orchestrator_dead_letter_queue 
       SET status = 'replayed', 
           replayed_at = NOW(), 
           replay_count = replay_count + 1,
           updated_at = NOW()
       WHERE job_id = $1 AND queue_name = $2`,
      [jobId, queueName]
    );
  }

  /**
   * Mark a job as failed to replay
   */
  async markFailed(jobId: string, queueName: string, reason: string): Promise<void> {
    await this.pool.query(
      `UPDATE orchestrator_dead_letter_queue 
       SET status = 'failed', 
           failed_reason = $3,
           updated_at = NOW()
       WHERE job_id = $1 AND queue_name = $2`,
      [jobId, queueName, reason]
    );
  }

  /**
   * Get jobs that match recoverable network error patterns
   */
  async getRecoverableJobs(limit = 100): Promise<DeadLetterJobRecord[]> {
    const result = await this.pool.query<DLQJobRow>(
      `SELECT * FROM orchestrator_dead_letter_queue 
       WHERE status = 'pending'
       AND (
         failed_reason ILIKE '%ECONNREFUSED%' OR
         failed_reason ILIKE '%ETIMEDOUT%' OR
         failed_reason ILIKE '%ENOTFOUND%' OR
         failed_reason ILIKE '%network%' OR
         failed_reason ILIKE '%connection%' OR
         failed_reason ILIKE '%timeout%'
       )
       ORDER BY failed_at ASC
       LIMIT $1`,
      [limit]
    );

    return result.rows.map(this.rowToRecord);
  }

  /**
   * Clean up old replayed jobs
   */
  async cleanupOldJobs(olderThanDays = 30): Promise<number> {
    const result = await this.pool.query(
      `DELETE FROM orchestrator_dead_letter_queue 
       WHERE status = 'replayed' 
       AND replayed_at < NOW() - INTERVAL '1 day' * $1`,
      [olderThanDays]
    );

    return result.rowCount ?? 0;
  }

  private rowToRecord(row: DLQJobRow): DeadLetterJobRecord {
    return {
      jobId: row.job_id,
      queueName: row.queue_name,
      failedReason: row.failed_reason,
      attemptsMade: row.attempts_made,
      payload: row.payload,
      failedAt: row.failed_at.toISOString(),
    };
  }
}
