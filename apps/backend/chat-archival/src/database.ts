/**
 * Database service for chat archival operations.
 */
import { Pool } from "pg";
import type { IdleSession, ChatMessage } from "./types.js";

export interface DatabaseService {
  findIdleSessions(olderThanDays: number, limit?: number): Promise<IdleSession[]>;
  getSessionById(sessionId: string): Promise<IdleSession | null>;
  getSessionMessages(sessionId: string): Promise<ChatMessage[]>;
  saveArchivalSummary(summary: {
    sessionId: string;
    userId: string;
    messageCount: number;
    summaryText: string;
    archivedToS3Key: string;
    archivedAt: string;
  }): Promise<void>;
  updateSessionArchived(sessionId: string, s3Key: string): Promise<void>;
  deleteSessionMessages(sessionId: string): Promise<number>;
}

export class PostgresDatabaseService implements DatabaseService {
  constructor(private readonly pool: Pool) {}

  async findIdleSessions(olderThanDays: number, limit = 100): Promise<IdleSession[]> {
    const cutoffDate = new Date();
    cutoffDate.setDate(cutoffDate.getDate() - olderThanDays);

    const result = await this.pool.query(
      `SELECT id, session_id, user_id, agent_id, delegation_id, message_count, total_tokens, last_message_at, created_at, archived_at, archived_to_s3_key
       FROM chat_sessions
       WHERE archived_at IS NULL
         AND last_message_at < $1
       ORDER BY last_message_at ASC
       LIMIT $2`,
      [cutoffDate.toISOString(), limit]
    );

    return result.rows as IdleSession[];
  }

  async getSessionById(sessionId: string): Promise<IdleSession | null> {
    const result = await this.pool.query(
      `SELECT id, session_id, user_id, agent_id, delegation_id, message_count, total_tokens, last_message_at, created_at, archived_at, archived_to_s3_key
       FROM chat_sessions
       WHERE session_id = $1`,
      [sessionId]
    );

    return (result.rows[0] as IdleSession) ?? null;
  }

  async getSessionMessages(sessionId: string): Promise<ChatMessage[]> {
    const result = await this.pool.query(
      `SELECT id, session_id, role, content, tool_call_id, name, token_count, created_at
       FROM chat_messages
       WHERE session_id = $1
       ORDER BY created_at ASC`,
      [sessionId]
    );

    return result.rows as ChatMessage[];
  }

  async saveArchivalSummary(summary: {
    sessionId: string;
    userId: string;
    messageCount: number;
    summaryText: string;
    archivedToS3Key: string;
    archivedAt: string;
  }): Promise<void> {
    await this.pool.query(
      `INSERT INTO chat_archival_summaries (session_id, user_id, message_count, summary_text, archived_to_s3_key, archived_at)
       VALUES ($1, $2, $3, $4, $5, $6)
       ON CONFLICT (session_id) DO NOTHING`,
      [summary.sessionId, summary.userId, summary.messageCount, summary.summaryText, summary.archivedToS3Key, summary.archivedAt]
    );
  }

  async updateSessionArchived(sessionId: string, s3Key: string): Promise<void> {
    await this.pool.query(
      `UPDATE chat_sessions
       SET archived_at = NOW(), archived_to_s3_key = $2, updated_at = NOW()
       WHERE session_id = $1`,
      [sessionId, s3Key]
    );
  }

  async deleteSessionMessages(sessionId: string): Promise<number> {
    const result = await this.pool.query(
      `DELETE FROM chat_messages WHERE session_id = $1`,
      [sessionId]
    );
    return result.rowCount ?? 0;
  }
}
