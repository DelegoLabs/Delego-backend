/**
 * Postgres-backed CompensationOutcomeStore (Issue #35)
 * Backs `workflow_compensation_outcomes` (database/migrations/020_workflow_compensation_outcomes.sql).
 */
import type { Pool } from "pg";
import type {
  CompensationOutcomeRecord,
  CompensationOutcomeStore,
  UpsertCompensationOutcomeInput,
} from "./compensation-outcome.js";

interface OutcomeRow {
  workflow_id: string;
  status: string;
  compensated_steps: string[];
  failed_steps: Array<{ step: string; error: string }>;
  cause: string | null;
  attempts: number;
  created_at: Date;
  updated_at: Date;
}

function toRecord(row: OutcomeRow): CompensationOutcomeRecord {
  return {
    workflowId: row.workflow_id,
    status: row.status as CompensationOutcomeRecord["status"],
    compensatedSteps: row.compensated_steps,
    failedSteps: row.failed_steps,
    cause: row.cause,
    attempts: row.attempts,
    createdAt: row.created_at.toISOString(),
    updatedAt: row.updated_at.toISOString(),
  };
}

export class PostgresCompensationOutcomeStore implements CompensationOutcomeStore {
  constructor(private readonly pool: Pool) {}

  async upsert(input: UpsertCompensationOutcomeInput): Promise<CompensationOutcomeRecord> {
    const { rows } = await this.pool.query<OutcomeRow>(
      `INSERT INTO workflow_compensation_outcomes
         (workflow_id, status, compensated_steps, failed_steps, cause, attempts)
       VALUES ($1, $2, $3::jsonb, $4::jsonb, $5, 1)
       ON CONFLICT (workflow_id) DO UPDATE SET
         status = EXCLUDED.status,
         compensated_steps = EXCLUDED.compensated_steps,
         failed_steps = EXCLUDED.failed_steps,
         cause = EXCLUDED.cause,
         attempts = workflow_compensation_outcomes.attempts + 1,
         updated_at = NOW()
       RETURNING *`,
      [
        input.workflowId,
        input.status,
        JSON.stringify(input.compensatedSteps),
        JSON.stringify(input.failedSteps),
        input.cause,
      ]
    );
    return toRecord(rows[0]);
  }

  async get(workflowId: string): Promise<CompensationOutcomeRecord | null> {
    const { rows } = await this.pool.query<OutcomeRow>(
      `SELECT * FROM workflow_compensation_outcomes WHERE workflow_id = $1`,
      [workflowId]
    );
    return rows[0] ? toRecord(rows[0]) : null;
  }
}
